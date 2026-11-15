import { expect, test } from "vitest";
import type { InteractionRequest } from "@ace/protocol";
import { ClientError } from "./index.ts";
import { harness, memory } from "./read-snapshots.fixture.ts";

/*
 * A request too large to send with its thread, read whole (ADR 0157): its JSON in pages from
 * offset 0, joined, and read again from the start when the request changed in between.
 */

const plan: InteractionRequest = {
  kind: "plan_review",
  title: "Rewrite the importer",
  markdown: `# Plan\n\n${"Step. ".repeat(40)}`,
};
const json = JSON.stringify(plan);
const target = { threadId: "thread", interactionId: "ask" };

async function started() {
  const f = harness(memory().storage);
  await f.start();
  const reads = () => f.sent.filter((message) => message.type === "interaction.read");
  let answered = 0;
  /** Answers the next `interaction.read` with `text` of `whole`, from the offset it asks. */
  const answer = async (whole: string, size: number, version = "v1") => {
    await expect.poll(() => reads().length).toBeGreaterThan(answered);
    const read = reads()[answered++];
    if (read?.type !== "interaction.read") throw new Error("No read");
    const nextOffset = Math.min(whole.length, read.offset + size);
    f.deliver({
      type: "interaction.data",
      requestId: read.requestId,
      threadId: read.threadId,
      interactionId: read.interactionId,
      version,
      offset: read.offset,
      nextOffset,
      total: whole.length,
      text: whole.slice(read.offset, nextOffset),
      eof: nextOffset === whole.length,
    });
    return read;
  };
  return { ...f, answer };
}

test("a summarized request reads whole from its pages, joined in order", async () => {
  const f = await started();
  const whole = f.client.readInteraction(target);
  const offsets: number[] = [];
  for (let at = 0; at < json.length; at += 100) offsets.push((await f.answer(json, 100)).offset);
  expect((await whole).request).toEqual(plan);
  expect(offsets).toEqual(offsets.map((_, index) => index * 100));
  await f.client.close();
});

test("a request replaced while it was read is read again from the start", async () => {
  const f = await started();
  const replaced: InteractionRequest = { ...plan, title: "Rewrite the importer, smaller" };
  const whole = f.client.readInteraction(target);
  await f.answer(json, 100, "v1");
  const restart = await f.answer(JSON.stringify(replaced), 100, "v2");
  expect(restart.offset).toBe(100);
  const again = JSON.stringify(replaced);
  const offsets: number[] = [];
  for (let at = 0; at < again.length; at += 100)
    offsets.push((await f.answer(again, 100, "v2")).offset);
  expect(offsets[0]).toBe(0);
  // Read under the version an answer to it names.
  expect(await whole).toEqual({ request: replaced, version: "v2" });
  await f.client.close();
});

test("a request that keeps changing while it is read fails after three restarts", async () => {
  const f = await started();
  const whole = f.client.readInteraction(target);
  const failed = expect(whole).rejects.toMatchObject({ code: "stale" });
  await f.answer(json, 100, "v0");
  for (let version = 1; version <= 4; version++) {
    await f.answer(json, 100, `v${version}`);
    if (version < 4) await f.answer(json, 100, `v${version}`);
  }
  await failed;
  await f.client.close();
});

test("the daemon's refusal to read a request fails the read with its code", async () => {
  const f = await started();
  const whole = f.client.readInteraction(target);
  await expect.poll(() => f.sent.some((message) => message.type === "interaction.read")).toBe(true);
  const read = f.sent.find((message) => message.type === "interaction.read");
  if (read?.type !== "interaction.read") throw new Error("No read");
  f.deliver({
    type: "error",
    requestId: read.requestId,
    code: "request_not_whole_here",
    message: "request_not_whole_here",
  });
  const error = await whole.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ClientError);
  expect(error).toMatchObject({ code: "daemon", message: "request_not_whole_here" });
  await f.client.close();
});

test("pages that don't join into a request fail the read", async () => {
  const f = await started();
  const whole = f.client.readInteraction(target);
  const failed = expect(whole).rejects.toMatchObject({ code: "protocol" });
  await f.answer(JSON.stringify({ kind: "nothing" }), 100);
  await failed;
  await f.client.close();
});
