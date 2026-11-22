import { ImageError } from "@ace/media/images";
import { maxSpadeChunkChars } from "@ace/protocol";
import type {
  DeviceScope,
  SpadeHttpRead,
  SpadeErrorCode,
  SpadeHttpPart,
  SpadeHttpRequest,
  SpadeMethod,
  ServerMessage,
} from "@ace/protocol";
import {
  splitBody,
  base64Stream,
  InvalidBase64,
  isTextContentType,
  requestBodyLimit,
  responseBodyLimit,
} from "../spade/bodies.ts";
import { spadeRequest, spadeUpload, type SpadeAnswer, type SpadeUpload } from "../spade/forward.ts";
import type { SpadeLink } from "../spade/link.ts";
import {
  personHeader,
  personOnlyRoute,
  personOnlyWrite,
  type PersonOnlyWrite,
} from "../spade/person-stamp.ts";
import { checkSpadePath, scopeFor } from "../spade/rules.ts";
import {
  PreviewBusy,
  spadePreviewGate,
  spadePreviewSource,
  type SpadePreviewGate,
} from "../spade/image-preview.ts";
import {
  answerRoute,
  answerWrite,
  memberHeader,
  type AnswerWrite,
  type MemberRequest,
} from "../spade/member-stamp.ts";

/** How long Spade has to answer once the whole body is sent. */
const requestTimeoutMs = 60_000;
/** How long an upload may wait for its next part before it is given up. */
const partTimeoutMs = 60_000;
/** Uploads one connection may have open at once. */
const maxUploads = 4;
/** Long answers one connection holds for reading, and for how long. */
const maxHeld = 4;
const heldMs = 60_000;

interface Upload {
  method: SpadeMethod;
  path: string;
  parts: number;
  next: number;
  bytes: number;
  limit: number;
  decode: (piece: string) => Buffer;
  finishDecode: () => Buffer;
  stream: SpadeUpload;
  controller: AbortController;
  /** Who asked, bound when it opened (ADR 0209 §4.2). */
  binding: { signal: AbortSignal; still(): boolean; release(): void };
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `spade.http` and its `spade.http.part`s (ADR 0121): checked, then forwarded to Spade with
 * Spade's token. Bodies pass through uninterpreted: text as UTF-8, base64 as its bytes; a body in
 * parts is streamed to Spade as each part arrives, never gathered whole.
 */
export function createSpadeHttp(context: {
  host(): Pick<SpadeLink, "ready"> | undefined;
  /** On an org host: binds a request to the principal asking (ADR 0209 §4.2); its release. */
  bindHandle?(handle: {
    operation: "spade";
    resource: { kind: "host" };
    close(reason: string): void;
  }): () => void;
  /** On an org host: who the socket is now; undefined on a person's machine. */
  holder?(): string | undefined;
  authorize(scope: DeviceScope): boolean;
  connected(): boolean;
  send(message: ServerMessage): void;
  /** Why nothing can be forwarded now: hidden on this machine, or not running. */
  unavailable(): { code: "hidden" | "unavailable"; message: string };
  /**
   * The person's stamp on a change only they may make (turning Full access on), or why this
   * caller can't make it: an agent, or the host token without a fresh sign-in.
   */
  stamp(write: PersonOnlyWrite): Promise<{ stamp: string } | { refused: string }>;
  /**
   * On an organization's host, a member's stamp on an answer to a raised request (ADR 0206
   * §2.3), or why this socket can't answer; undefined where answers go unstamped (a person's
   * machine).
   */
  answerStamp?(write: AnswerWrite): Promise<{ stamp: string } | { refused: string } | undefined>;
  /**
   * On an organization's host, a member's stamp on any other write (ADR 0206 §2.3), as headers;
   * undefined where this socket has no member standing (Spade then refuses a write to a shared
   * bot).
   */
  requestStamp?(write: MemberRequest): Record<string, string> | undefined;
  /**
   * The daemon's places for pictures' previews, shared by every socket (`spade/image-preview.ts`);
   * this socket's own when the host has none (a test's).
   */
  previews?: SpadePreviewGate | undefined;
}) {
  const uploads = new Map<string, Upload>();
  const previews = context.previews ?? spadePreviewGate();
  /** Aborted when the socket closes: its previews still waiting leave the line. */
  const closing = new AbortController();
  /** Long answers' pieces, read one at a time so no reply outgrows the socket's frame cap. */
  const held = new Map<
    string,
    { pieces: string[]; timer: ReturnType<typeof setTimeout>; still: () => boolean }
  >();
  /**
   * One request, bound to who asked it (ADR 0209 §4.2): aborted once they may no longer reach
   * Spade, and its answer sent only while the same principal still may.
   */
  const bind = (scope: DeviceScope) => {
    const holder = context.holder?.();
    const lost = new AbortController();
    const release =
      context.bindHandle?.({
        operation: "spade",
        resource: { kind: "host" },
        close: () => lost.abort(),
      }) ?? (() => {});
    return {
      signal: lost.signal,
      still: () =>
        !lost.signal.aborted && context.holder?.() === holder && context.authorize(scope),
      release,
    };
  };
  type Binding = ReturnType<typeof bind>;
  const release = (requestId: string) => {
    const answer = held.get(requestId);
    if (!answer) return;
    clearTimeout(answer.timer);
    held.delete(requestId);
  };
  const hold = (requestId: string, pieces: string[], still: () => boolean) => {
    release(requestId);
    // The oldest goes first: a connection holds a few long answers at most.
    if (held.size >= maxHeld) release(held.keys().next().value ?? "");
    const timer = setTimeout(() => release(requestId), heldMs);
    timer.unref?.();
    held.set(requestId, { pieces, timer, still });
  };
  const fail = (requestId: string, code: SpadeErrorCode, message: string) => {
    if (context.connected())
      context.send({
        type: "spade.http.result",
        requestId,
        result: { kind: "error", code, message },
      });
  };
  const respond = (requestId: string, answer: SpadeAnswer | undefined, binding: Binding) => {
    binding.release();
    if (!context.connected()) return;
    // Checked again now: the standing it was asked under may have ended while Spade answered.
    if (!binding.still())
      return fail(requestId, "forbidden", "Your access to Spade ended before its answer came.");
    if (!answer) return fail(requestId, "failed", "Spade didn't answer.");
    if (answer.kind === "too_large")
      return fail(requestId, "too_large", "Spade's answer is too large to forward.");
    const text = isTextContentType(answer.contentType);
    const pieces = splitBody(answer.body.toString(text ? "utf8" : "base64"), maxSpadeChunkChars);
    if (pieces.length > 1) hold(requestId, pieces, binding.still);
    context.send({
      type: "spade.http.result",
      requestId,
      result: {
        kind: "response",
        status: answer.status,
        body: pieces[0] ?? "",
        encoding: text ? "text" : "base64",
        ...(answer.contentType ? { contentType: answer.contentType.slice(0, 256) } : {}),
        ...(pieces.length > 1 ? { parts: pieces.length } : {}),
      },
    });
  };
  const drop = (requestId: string) => {
    const upload = uploads.get(requestId);
    if (!upload) return undefined;
    uploads.delete(requestId);
    clearTimeout(upload.timer);
    return upload;
  };
  const abandon = (requestId: string, code: SpadeErrorCode, message: string) => {
    const upload = drop(requestId);
    if (!upload) return;
    upload.binding.release();
    upload.controller.abort();
    fail(requestId, code, message);
  };
  const arm = (requestId: string, upload: Upload) => {
    clearTimeout(upload.timer);
    upload.timer = setTimeout(
      () => abandon(requestId, "failed", "The upload stopped before its last part."),
      partTimeoutMs,
    );
    upload.timer.unref?.();
  };

  /** Checks shared by both kinds of request; the ready connection, or why not. */
  function admit(message: SpadeHttpRequest) {
    if (!context.authorize(scopeFor(message.method))) {
      fail(
        message.requestId,
        "forbidden",
        message.method === "GET"
          ? "This device can't read Spade."
          : "This device can't make changes in Spade.",
      );
      return undefined;
    }
    const checked = checkSpadePath(message.path);
    if (!checked.ok) {
      fail(message.requestId, "invalid_path", checked.message);
      return undefined;
    }
    const ready = context.host()?.ready();
    if (!ready) {
      const refusal = context.unavailable();
      fail(message.requestId, refusal.code, refusal.message);
      return undefined;
    }
    return { connection: ready.connection, path: checked.path };
  }

  async function request(message: SpadeHttpRequest) {
    if (message.parts !== undefined) return open(message);
    const admitted = admit(message);
    if (!admitted) return;
    let body: Buffer | undefined;
    try {
      body =
        message.body === undefined
          ? undefined
          : message.encoding === "base64"
            ? decodeWhole(message.body)
            : Buffer.from(message.body, "utf8");
    } catch {
      return fail(message.requestId, "invalid_body", "The body isn't valid base64.");
    }
    if (body && body.length > requestBodyLimit(message.method, admitted.path))
      return fail(message.requestId, "too_large", "The body is too large for this route.");
    // A member's write on an organization's host carries their stamp over this very request.
    const member =
      message.method === "GET"
        ? undefined
        : context.requestStamp?.({ method: message.method, path: admitted.path, body });
    // Turning Full access on is the person's alone: stamped as theirs, or not forwarded. On an
    // organization's host a member asks instead, and Spade decides by its policy and their role.
    // A change only Spade can tell loosens anything goes unstamped from a caller without their
    // standing, and Spade makes it only if it tightens (ADR 0171, amendment 7).
    const guarded = personOnlyWrite(message.method, admitted.path, body);
    const personal = guarded ? await context.stamp(guarded) : undefined;
    if (personal && "refused" in personal && !member && !guarded?.optional)
      return fail(message.requestId, "forbidden", personal.refused);
    const stamped = personal && "stamp" in personal ? personal : undefined;
    // An answer to a shared bot's request: the member's, stamped, or not forwarded.
    const reply = answerWrite(message.method, admitted.path, body);
    const answered = reply ? await context.answerStamp?.(reply) : undefined;
    if (answered && "refused" in answered)
      return fail(message.requestId, "forbidden", answered.refused);
    const headers = {
      ...(stamped ? { [personHeader]: stamped.stamp } : {}),
      ...(answered ? { [memberHeader]: answered.stamp } : {}),
      ...member,
    };
    const binding = bind(scopeFor(message.method));
    const forward = (path: string, signal: AbortSignal) =>
      spadeRequest(
        admitted.connection,
        {
          method: message.method,
          path,
          body,
          ...(message.contentType ? { contentType: message.contentType } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        },
        {
          signal: AbortSignal.any([signal, binding.signal]),
          maxBytes: responseBodyLimit(message.method, path),
        },
      ).catch(() => undefined);
    // A picture's preview is the daemon's: Spade is asked for the image itself, in a place.
    const previewed = spadePreviewSource(message.method, admitted.path);
    if (previewed) return respond(message.requestId, await previewOf(previewed, forward), binding);
    respond(
      message.requestId,
      await forward(admitted.path, AbortSignal.timeout(requestTimeoutMs)),
      binding,
    );
  }

  /**
   * Spade's image as its preview, read and decoded in one of the daemon's places; Spade's own
   * refusal as it is; 503 while the places are full or the decode is late; 422 for bytes that
   * aren't a picture; nothing once the socket has closed.
   */
  async function previewOf(
    path: string,
    forward: (path: string, signal: AbortSignal) => Promise<SpadeAnswer | undefined>,
  ): Promise<SpadeAnswer | undefined> {
    let answer: SpadeAnswer | undefined;
    const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(requestTimeoutMs)]);
    try {
      const png = await previews.preview(
        closing.signal,
        async () => {
          answer = await forward(path, signal);
          const shown = answer?.kind === "response" && answer.status >= 200 && answer.status < 300;
          return shown && answer?.kind === "response" ? answer.body : undefined;
        },
        later,
      );
      if (!png) return answer;
      return { kind: "response", status: 200, body: png, contentType: "image/png" };
    } catch (error) {
      if (closing.signal.aborted) return undefined;
      if (error instanceof PreviewBusy) return problemAnswer(503, error.message);
      // ace-media busy, starting, gone or slow: the picture may preview later.
      if (error instanceof ImageError && error.passing)
        return problemAnswer(503, "Spade's pictures are busy. Try again in a moment.");
      return problemAnswer(422, "This picture can't be previewed.");
    }
  }

  function open(message: SpadeHttpRequest) {
    if (uploads.has(message.requestId))
      return fail(message.requestId, "invalid_body", "This request is already uploading.");
    if (message.body !== undefined)
      return fail(message.requestId, "invalid_body", "A body in parts has no inline body.");
    if (uploads.size >= maxUploads)
      return fail(message.requestId, "limit", "Too many uploads are open on this connection.");
    const admitted = admit(message);
    if (!admitted) return;
    // A change only the person may make is read whole before it is stamped.
    if (
      personOnlyRoute(message.method, admitted.path) !== undefined ||
      answerRoute(message.method, admitted.path) !== undefined
    )
      return fail(message.requestId, "invalid_body", "Send this change in one piece.");
    const controller = new AbortController();
    const binding = bind(scopeFor(message.method));
    binding.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const base64 = base64Stream();
    const upload: Upload = {
      method: message.method,
      path: admitted.path,
      parts: message.parts ?? 1,
      next: 0,
      bytes: 0,
      limit: requestBodyLimit(message.method, admitted.path),
      decode:
        message.encoding === "base64"
          ? (piece) => base64.push(piece)
          : (piece) => Buffer.from(piece, "utf8"),
      finishDecode: message.encoding === "base64" ? () => base64.finish() : () => Buffer.alloc(0),
      stream: spadeUpload(
        admitted.connection,
        {
          method: message.method,
          path: admitted.path,
          contentType: message.contentType,
        },
        controller.signal,
      ),
      controller,
      binding,
      timer: setTimeout(() => {}, 0),
    };
    uploads.set(message.requestId, upload);
    arm(message.requestId, upload);
    if (context.connected())
      context.send({ type: "spade.http.open", requestId: message.requestId });
  }

  async function part(message: SpadeHttpPart) {
    const upload = uploads.get(message.requestId);
    // A part for an upload that already ended (refused, failed or stalled): nothing to add to.
    if (!upload) return;
    if (message.index !== upload.next)
      return abandon(message.requestId, "invalid_body", `Part ${upload.next} was expected next.`);
    if (!context.authorize(scopeFor(upload.method)))
      return abandon(message.requestId, "forbidden", "This device can't make changes in Spade.");
    let piece: Buffer;
    try {
      piece = upload.decode(message.body);
      if (message.index === upload.parts - 1) piece = Buffer.concat([piece, upload.finishDecode()]);
    } catch (error) {
      if (!(error instanceof InvalidBase64)) throw error;
      return abandon(message.requestId, "invalid_body", "A part isn't valid base64.");
    }
    upload.bytes += piece.length;
    if (upload.bytes > upload.limit)
      return abandon(message.requestId, "too_large", "The body is too large for this route.");
    upload.next++;
    arm(message.requestId, upload);
    try {
      if (piece.length) await upload.stream.write(piece);
    } catch {
      return abandon(message.requestId, "failed", "Spade stopped taking the upload.");
    }
    if (upload.next < upload.parts) return;
    drop(message.requestId);
    const timeout = setTimeout(() => upload.controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    // Never awaited: the body is all sent, and Spade may take a minute to answer; the socket's
    // next message must not wait for it.
    void upload.stream
      .finish(responseBodyLimit(upload.method, upload.path))
      .catch(() => undefined)
      .then((answer) => {
        clearTimeout(timeout);
        respond(message.requestId, answer, upload.binding);
      })
      // A send that fails here has no request left to answer.
      .catch(() => undefined);
  }

  function read(message: SpadeHttpRead) {
    if (!context.connected()) return;
    const kept = held.get(message.requestId);
    // A long answer's later pieces go only to whoever may still read it.
    if (kept && !kept.still()) {
      release(message.requestId);
      return context.send({
        type: "spade.http.chunk",
        requestId: message.requestId,
        index: message.index,
        body: "",
        gone: true,
      });
    }
    const pieces = kept?.pieces;
    const body = pieces?.[message.index];
    if (body === undefined)
      return context.send({
        type: "spade.http.chunk",
        requestId: message.requestId,
        index: message.index,
        body: "",
        gone: true,
      });
    context.send({
      type: "spade.http.chunk",
      requestId: message.requestId,
      index: message.index,
      body,
    });
    if (message.index === (pieces?.length ?? 0) - 1) release(message.requestId);
  }

  return {
    request,
    part,
    read,
    close() {
      closing.abort();
      // Deleting the entry being visited is safe while iterating a Map.
      for (const requestId of held.keys()) release(requestId);
      for (const requestId of uploads.keys()) drop(requestId)?.controller.abort();
    },
  };
}

function decodeWhole(body: string): Buffer {
  const stream = base64Stream();
  return Buffer.concat([stream.push(body), stream.finish()]);
}

/** An answer of the daemon's own, in Spade's problem shape. */
function problemAnswer(status: number, title: string): SpadeAnswer {
  return {
    kind: "response",
    status,
    body: Buffer.from(JSON.stringify({ title })),
    contentType: "application/json",
  };
}

/** A timer that never keeps the daemon alive, and its cancel. */
function later(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
