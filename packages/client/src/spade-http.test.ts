import { maxSpadeChunkChars, maxSpadePartChars, maxSpadeRequestBytes } from "@ace/protocol";
import { expect, test } from "vitest";
import { spadeBodyParts, spadeExchange, type SpadeHttpOwner } from "./spade-http.ts";

/**
 * A daemon's `spade.http` as the client sees it: an upload is answered `spade.http.open`, its
 * parts are joined in order (a part for an unknown upload is dropped, as the daemon drops it) and
 * its result comes as a later message; an answer longer than one message is held in pieces for
 * `spade.http.read`.
 */
function fakeDaemon(
  answer: (body: string) => string,
  opts: { forget?: number; refuseUploads?: boolean } = {},
) {
  const uploads = new Map<string, { parts: number; got: string[]; done(): void }>();
  const listeners = new Set<(message: unknown) => void>();
  let partsSeen = 0;
  const held = new Map<string, string[]>();
  let forget = opts.forget ?? 0;
  const received: string[] = [];
  const respond = (requestId: string, body: string) => {
    const text = answer(body);
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += maxSpadeChunkChars)
      pieces.push(text.slice(at, at + maxSpadeChunkChars));
    if (!pieces.length) pieces.push("");
    held.set(requestId, pieces);
    received.push(body);
    return {
      type: "spade.http.result" as const,
      requestId,
      result: {
        kind: "response" as const,
        status: 200,
        body: pieces[0] ?? "",
        encoding: "text" as const,
        ...(pieces.length > 1 ? { parts: pieces.length } : {}),
      },
    };
  };
  const owner = {
    request: (async (input: Record<string, unknown>, options?: { requestId?: string }) => {
      const requestId = options?.requestId ?? "x";
      if (input.type === "spade.http.read") {
        const pieces = held.get(requestId);
        if (forget > 0) {
          forget--;
          return { type: "spade.http.chunk", requestId, index: input.index, body: "", gone: true };
        }
        return {
          type: "spade.http.chunk",
          requestId,
          index: input.index,
          body: pieces?.[input.index as number] ?? "",
        };
      }
      if (typeof input.parts === "number") {
        if (opts.refuseUploads)
          return {
            type: "spade.http.result",
            requestId,
            result: { kind: "error", code: "limit", message: "Too many uploads." },
          };
        uploads.set(requestId, {
          parts: input.parts,
          got: [],
          done() {
            const result = respond(requestId, this.got.join(""));
            for (const listener of listeners) listener(result);
          },
        });
        return { type: "spade.http.open", requestId };
      }
      return respond(requestId, (input.body as string | undefined) ?? "");
    }) as unknown as SpadeHttpOwner["request"],
    send: ((message: { type: string; requestId: string; index: number; body: string }) => {
      partsSeen++;
      const upload = uploads.get(message.requestId);
      if (!upload || message.index !== upload.got.length) return;
      upload.got.push(message.body);
      if (upload.got.length === upload.parts) upload.done();
    }) as SpadeHttpOwner["send"],
    onMessage: ((listener: (message: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }) as SpadeHttpOwner["onMessage"],
  };
  return { owner, received, partsSent: () => partsSeen };
}

let ids = 0;
const id = () => `r${++ids}`;

test("a body larger than one message reaches the daemon whole, in parts after the request", async () => {
  const body = JSON.stringify({
    text: "Look",
    images: [{ data: "A".repeat(3 * maxSpadeRequestBytes) }],
  });
  const daemon = fakeDaemon(() => "{}");
  const answer = await spadeExchange(daemon.owner, { method: "POST", path: "/v1/x", body }, { id });
  expect(answer).toMatchObject({ kind: "response", status: 200 });
  expect(daemon.received).toEqual([body]);
});

test("a long answer's pieces are read and joined in order", async () => {
  const image = "QUJD".repeat(maxSpadeChunkChars);
  const daemon = fakeDaemon(() => image);
  const answer = await spadeExchange(daemon.owner, { method: "GET", path: "/v1/images/a" }, { id });
  expect(answer.kind === "response" && answer.body).toBe(image);
});

test("an answer the daemon let go is asked for again, once", async () => {
  const text = "x".repeat(maxSpadeChunkChars + 10);
  const again = fakeDaemon(() => text, { forget: 1 });
  const answer = await spadeExchange(again.owner, { method: "GET", path: "/v1/a" }, { id });
  expect(answer.kind === "response" && answer.body).toBe(text);
  expect(again.received).toHaveLength(2);

  const lost = fakeDaemon(() => text, { forget: 2 });
  expect(await spadeExchange(lost.owner, { method: "GET", path: "/v1/a" }, { id })).toMatchObject({
    kind: "error",
    code: "failed",
  });
});

test("parts join back to the body and never split a surrogate pair or a base64 quartet", () => {
  const text = `${"a".repeat(maxSpadePartChars - 1)}😀${"b".repeat(10)}`;
  const parts = spadeBodyParts(text, maxSpadePartChars, "text");
  expect(parts.join("")).toBe(text);
  expect(parts[0]?.endsWith("\ud83d")).toBe(false);
  expect(parts.every((part) => part.length <= maxSpadePartChars)).toBe(true);

  const base64 = "QUJD".repeat(100) + "QQ==";
  const pieces = spadeBodyParts(base64, 10, "base64");
  expect(pieces.join("")).toBe(base64);
  expect(pieces.slice(0, -1).every((piece) => piece.length % 4 === 0)).toBe(true);
});

test("an upload the daemon refuses sends no parts and says why", async () => {
  const body = "A".repeat(2 * maxSpadeRequestBytes);
  const daemon = fakeDaemon(() => "{}", { refuseUploads: true });
  const answer = await spadeExchange(daemon.owner, { method: "POST", path: "/v1/x", body }, { id });
  expect(answer).toEqual({ kind: "error", code: "limit", message: "Too many uploads." });
  expect(daemon.partsSent()).toBe(0);
});
