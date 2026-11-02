import { ThreadId, type Attachment, type ContextResult } from "@ace/protocol";
import { expect, test } from "vitest";
import { listThreadAttachments } from "./thread-attachment-list.ts";

type Result = ContextResult["result"];
const thread = ThreadId.parse("thread");
const file = (n: number): Attachment => ({
  sha256: n.toString(16).padStart(64, "0"),
  bytes: n,
  mimeType: "image/png",
  name: `shot-${n}.png`,
});
const refuse = (result: Result): never => {
  throw new Error(`refused: ${result.kind}`);
};

/** A daemon holding `count` files that answers in pages of `size`, newest first. */
function pagingDaemon(count: number, size: number) {
  const newest = Array.from({ length: count }, (_, n) => file(count - 1 - n));
  const asked: (string | undefined)[] = [];
  return {
    asked,
    async ask(operation: { cursor?: string | undefined }): Promise<Result> {
      asked.push(operation.cursor);
      const from = operation.cursor ? Number(operation.cursor) : 0;
      const page = newest.slice(from, from + size);
      return {
        kind: "attachments",
        attachments: page,
        ...(from + size < count ? { nextCursor: String(from + size) } : {}),
      };
    },
  };
}

test("every file of a long thread comes back, newest first, by following each page's cursor", async () => {
  const daemon = pagingDaemon(1000, 256);
  const files = await listThreadAttachments(thread, (op) => daemon.ask(op), refuse);
  expect(files).toHaveLength(1000);
  expect(files[0]?.name).toBe("shot-999.png");
  expect(files.at(-1)?.name).toBe("shot-0.png");
  expect(daemon.asked).toEqual([undefined, "256", "512", "768"]);
});

test("a daemon from before paging answers once and its one page is the list", async () => {
  const old = async (): Promise<Result> => ({ kind: "attachments", attachments: [file(1)] });
  expect(await listThreadAttachments(thread, old, refuse)).toEqual([file(1)]);
});

test("a cursor the daemon repeats ends the walk instead of looping", async () => {
  let calls = 0;
  const stuck = async (): Promise<Result> => {
    calls++;
    return { kind: "attachments", attachments: [file(calls)], nextCursor: "same" };
  };
  expect(await listThreadAttachments(thread, stuck, refuse)).toHaveLength(2);
  expect(calls).toBe(2);
});

test("a refusal mid-walk is handed to the caller rather than returning a partial list", async () => {
  let calls = 0;
  const failing = async (): Promise<Result> =>
    ++calls === 1
      ? { kind: "attachments", attachments: [file(1)], nextCursor: "1" }
      : { kind: "error", code: "forbidden", message: "Thread access denied" };
  await expect(listThreadAttachments(thread, failing, refuse)).rejects.toThrow("refused: error");
});
