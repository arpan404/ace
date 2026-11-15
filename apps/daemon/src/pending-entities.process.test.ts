import { afterEach, expect, test } from "vitest";
import { Interaction, InteractionId, type ServerMessage } from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";

// A phone's inbox finds what waits on the person by reading a thread's interactions newest
// first. Installed phones stop after four pages, so a pending request must never sit behind
// pages of resolved ones: pages carry every pending interaction first, whatever its age, then the
// resolved ones, each entity once.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const approval = (threadId: string, id: string, description: string) =>
  Interaction.parse({
    id,
    threadId,
    agentId: "root",
    blocking: true,
    request: {
      kind: "approval",
      title: `Run ${id}`,
      description,
      options: [{ id: `${id}:allow`, label: "Allow once", kind: "allow_once" }],
    },
    state: "pending",
    createdAt: 1,
  });

/** One pending approval, then `resolved` newer ones of about `bytes` each, answered. */
async function thread(resolved: number, bytes: number) {
  const f = await fixture();
  cleanups.push(() => f.close());
  f.store.appendEvents(f.thread.id, [
    { type: "interaction.opened", interaction: approval(f.thread.id, "waiting", "Deploy now?") },
  ]);
  for (let index = 0; index < resolved; index++) {
    const id = `done-${index}`;
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, id, "x".repeat(bytes)) },
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse(id),
        state: "resolved",
        resolution: { kind: "approval", optionId: `${id}:allow` },
        closedAt: 2,
      },
    ]);
  }
  const client = await f.connect(token);
  await client.next();
  let request = 0;
  const page = async (before: number) => {
    client.send({
      type: "entities.page",
      requestId: `p${++request}`,
      threadId: f.thread.id,
      collection: "interactions",
      before,
      limit: 50,
    });
    for (;;) {
      const reply: ServerMessage = await client.next();
      if (reply.type === "entities.page" && reply.requestId === `p${request}`) return reply.page;
    }
  };
  /** A newest-first page, asking for `maxBytes` when given (an older reader does not). */
  const pageOf = async (before: number, maxBytes: number | undefined) => {
    client.send({
      type: "entities.page",
      requestId: `m${++request}`,
      threadId: f.thread.id,
      collection: "interactions",
      before,
      limit: 50,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    for (;;) {
      const reply: ServerMessage = await client.next();
      if (reply.type === "entities.page" && reply.requestId === `m${request}`) return reply.page;
    }
  };
  return { page, pageOf };
}

test("a pending request behind many large resolved ones is on the newest page", async () => {
  // 16 resolved of about 40 KiB: more than four of today's 128 KiB pages.
  const { page } = await thread(16, 40 * 1024);
  const first = await page(Number.MAX_SAFE_INTEGER);
  if (first.collection !== "interactions") throw new Error("shape");
  expect(
    first.entries.filter((entry) => entry.state === "pending").map((entry) => entry.id),
  ).toEqual(["waiting"]);
});

test("an installed phone that reads four pages finds the pending request, and paging lists each once", async () => {
  const { page } = await thread(16, 40 * 1024);
  const seen: string[] = [];
  let before: number | null = Number.MAX_SAFE_INTEGER;
  for (let read = 0; before !== null; read++) {
    const result = await page(before);
    if (result.collection !== "interactions") throw new Error("shape");
    seen.push(...result.entries.map((entry) => entry.id));
    // What an installed phone has once it stops after its fourth page.
    if (read === 3) expect(seen).toContain("waiting");
    before = result.entitiesBefore;
  }
  expect(seen.toSorted()).toEqual(
    ["waiting", ...Array.from({ length: 16 }, (_, i) => `done-${i}`)].toSorted(),
  );
});

test("pending requests that fill more than the newest page come first, then the resolved ones, each once", async () => {
  // Three pending of about 60 KiB (past the page's 128 KiB on their own) and two resolved.
  const f = await fixture();
  cleanups.push(() => f.close());
  for (const id of ["ask-1", "ask-2", "ask-3"])
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, id, "y".repeat(60 * 1024)) },
    ]);
  for (const id of ["done-1", "done-2"])
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, id, "z") },
      {
        type: "interaction.closed",
        interactionId: InteractionId.parse(id),
        state: "resolved",
        resolution: { kind: "approval", optionId: `${id}:allow` },
        closedAt: 2,
      },
    ]);
  const client = await f.connect(token);
  await client.next();
  const seen: string[] = [];
  let before: number | null = Number.MAX_SAFE_INTEGER;
  for (let read = 0; before !== null; read++) {
    if (read > 10) throw new Error("Paging did not end");
    client.send({
      type: "entities.page",
      requestId: `q${read}`,
      threadId: f.thread.id,
      collection: "interactions",
      before,
      limit: 50,
    });
    let reply: ServerMessage;
    do reply = await client.next();
    while (!(reply.type === "entities.page" && reply.requestId === `q${read}`));
    if (reply.page.collection !== "interactions") throw new Error("shape");
    seen.push(...reply.page.entries.map((entry) => entry.id));
    expect(reply.page.entitiesBefore).not.toBe(before);
    before = reply.page.entitiesBefore;
  }
  // Pending ones, over two pages, before any resolved one.
  expect(seen.slice(0, 3).toSorted()).toEqual(["ask-1", "ask-2", "ask-3"]);
  expect(seen.toSorted()).toEqual(["ask-1", "ask-2", "ask-3", "done-1", "done-2"]);
});

/** The bytes of a page's entries, as the daemon weighs them. */
const size = (entries: readonly unknown[]) =>
  entries.reduce<number>((total, entry) => total + JSON.stringify(entry).length, 0);

test("a reader that asks for smaller pages gets them, with the pending request still first", async () => {
  const { pageOf } = await thread(16, 40 * 1024);
  const small = await pageOf(Number.MAX_SAFE_INTEGER, 64 * 1024);
  const whole = await pageOf(Number.MAX_SAFE_INTEGER, undefined);
  if (small.collection !== "interactions" || whole.collection !== "interactions")
    throw new Error("shape");
  expect(small.entries.map((entry) => entry.id)).toContain("waiting");
  // Without asking, a reader keeps the page it always had.
  expect(size(whole.entries)).toBeGreaterThan(96 * 1024);
  expect(size(small.entries)).toBeLessThanOrEqual(64 * 1024 + 41 * 1024);
  expect(small.entries.length).toBeLessThan(whole.entries.length);
});
