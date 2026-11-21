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
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `spade.http` and its `spade.http.part`s (ADR 0121): checked, then forwarded to Spade with
 * Spade's token. Bodies pass through uninterpreted: text as UTF-8, base64 as its bytes; a body in
 * parts is streamed to Spade as each part arrives, never gathered whole.
 */
export function createSpadeHttp(context: {
  host(): Pick<SpadeLink, "ready"> | undefined;
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
}) {
  const uploads = new Map<string, Upload>();
  /** Long answers' pieces, read one at a time so no reply outgrows the socket's frame cap. */
  const held = new Map<string, { pieces: string[]; timer: ReturnType<typeof setTimeout> }>();
  const release = (requestId: string) => {
    const answer = held.get(requestId);
    if (!answer) return;
    clearTimeout(answer.timer);
    held.delete(requestId);
  };
  const hold = (requestId: string, pieces: string[]) => {
    release(requestId);
    // The oldest goes first: a connection holds a few long answers at most.
    if (held.size >= maxHeld) release(held.keys().next().value ?? "");
    const timer = setTimeout(() => release(requestId), heldMs);
    timer.unref?.();
    held.set(requestId, { pieces, timer });
  };
  const fail = (requestId: string, code: SpadeErrorCode, message: string) => {
    if (context.connected())
      context.send({
        type: "spade.http.result",
        requestId,
        result: { kind: "error", code, message },
      });
  };
  const respond = (requestId: string, answer: SpadeAnswer | undefined) => {
    if (!context.connected()) return;
    if (!answer) return fail(requestId, "failed", "Spade didn't answer.");
    if (answer.kind === "too_large")
      return fail(requestId, "too_large", "Spade's answer is too large to forward.");
    const text = isTextContentType(answer.contentType);
    const pieces = splitBody(answer.body.toString(text ? "utf8" : "base64"), maxSpadeChunkChars);
    if (pieces.length > 1) hold(requestId, pieces);
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
    const answer = await spadeRequest(
      admitted.connection,
      {
        method: message.method,
        path: admitted.path,
        body,
        ...(message.contentType ? { contentType: message.contentType } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      },
      {
        signal: AbortSignal.timeout(requestTimeoutMs),
        maxBytes: responseBodyLimit(message.method, admitted.path),
      },
    ).catch(() => undefined);
    respond(message.requestId, answer);
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
        respond(message.requestId, answer);
      })
      // A send that fails here has no request left to answer.
      .catch(() => undefined);
  }

  function read(message: SpadeHttpRead) {
    if (!context.connected()) return;
    const pieces = held.get(message.requestId)?.pieces;
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
