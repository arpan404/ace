import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, native, open, pump, reset, until } from "./thread-harness.ts";
import { fillHistory } from "./thread-history.ts";

/*
 * A window larger than the daemon's snapshot fills in behind the first paint, over the real SDK
 * and the fake daemon (`thread-harness.ts`).
 */

afterEach(reset);

const rowText = (frame: Record<string, unknown>) => (frame.row as { text?: string } | null)?.text;

test("a long thread is ready with its latest items before any older page arrives", async () => {
  const fake = fixture();
  fake.createThread({ id: "long", workspaceId: "ace", title: "Long", provider: "codex" });
  fake.apply("long", [facts.rootAgent("codex"), facts.turn("root")]);
  for (let index = 0; index < 500; index++)
    fake.apply("long", [facts.message("root", `m-${index}`, "assistant", `Step ${index}`)]);
  const client = connect(fake, 2200);
  open(client, "long");
  const lease = client.thread("long");
  const filled = fillHistory({
    owner: client,
    store: lease.store,
    threadId: "long",
    limit: 500,
    current: () => true,
    drained: () => pump.drained(),
    signal: new AbortController().signal,
  });
  await filled;
  await until(
    () => native.frames.filter((frame) => frame.type === "thread.item" && frame.row).length >= 500,
    "the older pages",
  );
  console.log(
    JSON.stringify(
      Object.entries(
        native.frames.reduce<Record<string, number>>(
          (all, f) => ((all[String(f.type)] = (all[String(f.type)] ?? 0) + 1), all),
          {},
        ),
      ),
    ),
  );
  const ready = native.frames.findIndex((frame) => frame.type === "thread.ready");
  const oldest = native.frames.findIndex(
    (frame) => frame.type === "thread.item" && rowText(frame) === "Step 0",
  );
  const newest = native.frames.findIndex(
    (frame) => frame.type === "thread.item" && rowText(frame) === "Step 499",
  );
  expect(ready).toBeGreaterThan(newest);
  expect(ready).toBeLessThan(oldest);
  lease.release();
});

test("older pages keep the rows already shown where they are, and native still orders every row", async () => {
  const fake = fixture();
  fake.createThread({ id: "paged", workspaceId: "ace", title: "Paged", provider: "codex" });
  fake.apply("paged", [facts.rootAgent("codex"), facts.turn("root")]);
  for (let index = 0; index < 900; index++)
    fake.apply("paged", [
      facts.message("root", `m-${index}`, index % 5 ? "assistant" : "user", `Step ${index}`),
    ]);
  const client = connect(fake, 2200);
  open(client, "paged");
  const lease = client.thread("paged");
  await fillHistory({
    owner: client,
    store: lease.store,
    threadId: "paged",
    limit: 900,
    current: () => true,
    drained: () => pump.drained(),
    signal: new AbortController().signal,
  });
  await until(
    () => native.frames.filter((frame) => frame.type === "thread.item").length >= 900,
    "every row",
  );
  await pump.drained();
  // As Swift does: the last index each row was given, by its row or a position patch.
  const index = new Map<string, number>();
  const texts = new Map<string, string>();
  for (const frame of native.frames) {
    const id = String(frame.id);
    if (frame.type === "thread.item" && frame.row) {
      const row = frame.row as { index?: number | null; text?: string };
      if (typeof row.index === "number") index.set(id, row.index);
      if (row.text) texts.set(id, row.text);
    }
    if (frame.type === "thread.position" && typeof frame.index === "number")
      index.set(id, frame.index);
  }
  const shown = [...index.entries()].toSorted((a, b) => a[1] - b[1]).map(([id]) => texts.get(id));
  expect(shown.filter((text) => text?.startsWith("Step "))).toEqual(
    Array.from({ length: 900 }, (_, step) => `Step ${step}`),
  );
  // Paging in 700 older rows moved none of the rows already on screen.
  const moves = native.frames.filter(
    (frame) => frame.type === "thread.position" || frame.type === "thread.blockPosition",
  );
  expect(moves.length).toBeLessThan(50);
  lease.release();
});
