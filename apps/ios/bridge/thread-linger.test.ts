import { afterEach, expect, test } from "vitest";
import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { connect, fixture, pump, reset, sent, until } from "./thread-harness.ts";
import { ThreadLinger, lingerLimit, lingerMs } from "./thread-linger.ts";
import { ThreadVisit } from "./thread-visit.ts";

/*
 * A thread the person just left stays followed a while (ADR 0146), so reopening it paints what
 * changed meanwhile at once instead of after a fresh subscription. Over the real SDK and the fake
 * daemon; the linger's timer is a test clock.
 */

const hooks = { leaving() {}, opened() {} };
/** Timers the linger set, run on demand. */
class Clock {
  timers: { delayMs: number; run: () => void; cancelled: boolean }[] = [];
  schedule = (delayMs: number, run: () => void) => {
    const timer = { delayMs, run, cancelled: false };
    this.timers.push(timer);
    return () => void (timer.cancelled = true);
  };
  runAll(): void {
    for (const timer of this.timers.splice(0)) if (!timer.cancelled) timer.run();
  }
}

let visit: ThreadVisit | undefined;
afterEach(async () => {
  visit?.back();
  visit = undefined;
  await reset();
});

function seed(fake: FakeDaemon, id: string) {
  fake.createThread({ id, workspaceId: "ace", title: id, provider: "codex" });
  fake.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", `ask-${id}`, "user", "A question"),
    facts.endTurn("root"),
  ]);
}
/** Subscriptions to single threads, and how many of them were dropped. */
function threadSubscriptions() {
  const ids = new Set<string>();
  let dropped = 0;
  for (const text of sent) {
    const message = JSON.parse(text) as {
      type?: string;
      subscriptionId?: string;
      scope?: { kind?: string };
    };
    if (message.type === "subscribe" && message.scope?.kind === "thread" && message.subscriptionId)
      ids.add(message.subscriptionId);
    if (message.type === "unsubscribe" && message.subscriptionId && ids.has(message.subscriptionId))
      dropped++;
  }
  return { started: ids.size, dropped };
}

async function opened(client: ReturnType<typeof connect>, id: string, warm = false) {
  visit?.open(client, id, warm);
  await until(() => visit?.store?.cursor !== undefined && !visit.store.syncing, `${id} to be read`);
}

test("a thread left a moment ago is still current the instant it is reopened", async () => {
  const fake = fixture();
  seed(fake, "kept");
  seed(fake, "other");
  const client = connect(fake);
  visit = new ThreadVisit(
    pump,
    hooks,
    undefined,
    undefined,
    undefined,
    new ThreadLinger(new Clock().schedule),
  );
  await opened(client, "kept");
  await opened(client, "other");
  const subscribes = threadSubscriptions().started;
  fake.apply("kept", [
    facts.turn("root"),
    facts.message("root", "late", "user", "Asked while away"),
  ]);
  // The in-process daemon delivers at once to anything still following the thread.
  await new Promise((resolve) => setTimeout(resolve, 100));

  visit.open(client, "kept", true);
  // Followed all along: nothing to wait for, and no new subscription.
  expect(visit.store?.syncing).toBe(false);
  expect(visit.store?.unconfirmed).toBe(false);
  const texts = (visit.store?.order ?? []).map((id) =>
    JSON.stringify(visit?.store?.item(id) ?? {}),
  );
  expect(texts.some((text) => text.includes("Asked while away"))).toBe(true);
  expect(threadSubscriptions().started).toBe(subscribes);
});

test("a left thread is let go after the linger", async () => {
  const fake = fixture();
  seed(fake, "kept");
  const client = connect(fake);
  const clock = new Clock();
  visit = new ThreadVisit(
    pump,
    hooks,
    undefined,
    undefined,
    undefined,
    new ThreadLinger(clock.schedule),
  );
  await opened(client, "kept");
  visit.back();
  expect(threadSubscriptions().dropped).toBe(0);
  expect(clock.timers.map((timer) => timer.delayMs)).toEqual([lingerMs]);
  clock.runAll();
  expect(threadSubscriptions().dropped).toBe(1);
});

test("only the most recently left threads linger", async () => {
  const fake = fixture();
  const ids = Array.from({ length: lingerLimit + 2 }, (_, index) => `t-${index}`);
  for (const id of ids) seed(fake, id);
  const client = connect(fake);
  visit = new ThreadVisit(
    pump,
    hooks,
    undefined,
    undefined,
    undefined,
    new ThreadLinger(new Clock().schedule),
  );
  for (const id of ids) await opened(client, id);
  visit.back();
  // Every thread was left; the two left longest ago are let go at once.
  expect(threadSubscriptions().dropped).toBe(2);
});
