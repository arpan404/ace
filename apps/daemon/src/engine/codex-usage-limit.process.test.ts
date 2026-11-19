import { afterEach, expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import type { ScriptedStep } from "@ace/adapter-testkit";
import { cleanupRecovery, text, sends } from "./recovery-test-support.ts";
import {
  clearedThen,
  codexThread,
  frame,
  minute,
  snapshot,
  started,
  turn,
  usageLimit,
} from "./codex-limit-test-support.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";

/*
 * Usage limits through the real Codex translator and the real accounts service: app-server
 * frames go through the account registry exactly as in the daemon, and the thread's hold is
 * decided by what the provider definitely said.
 */

afterEach(cleanupRecovery);

test("a turn error without a definite limit signal does not hold queued messages", async () => {
  const { h, registry, close } = await codexThread([
    {
      on: "send",
      frames: [
        started,
        // A throttle Codex gave up retrying, in words that mention a rate limit.
        ...turn("A", "failed", {
          message: "Rate limit reached for gpt-6.1-sol on tokens per min. Please try again in 20s.",
          codexErrorInfo: "rateLimitExceeded",
        }),
      ],
    },
    { on: "send", frames: turn("B", "completed") },
  ]);
  try {
    const id = await h.create();
    expect(h.store.getThread(id)?.status.state).toBe("failed");
    expect(h.engine.queue(id)).toMatchObject({ paused: false });
    expect(registry.summary("account-a", h.clock.now())?.availability).toBe("available");
    h.command({ type: "thread.send", threadId: id, input: text("next") });
    await h.engine.flush();
    expect(sends(h.adapter)).toHaveLength(2);
    expect(h.engine.queue(id).messages).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

const hitLimit = (reset: number): ScriptedStep[] => [
  {
    on: "send",
    frames: [started, frame(snapshot(100, reset)), ...turn("A", "failed", usageLimit)],
  },
  // Carrying on closes the limited session and opens a fresh one.
  { on: "close" },
];
const carriesOn: ScriptedStep[] = [
  { on: "send", frames: [started, ...turn("B", "completed")] },
  { on: "send", frames: turn("C", "completed") },
];
const resume = (h: Awaited<ReturnType<typeof codexThread>>["h"], id: ThreadId) =>
  h.command({ type: "thread.resume", threadId: id, expectedRevision: h.engine.queue(id).revision });

test("an explicit Codex rate-limit event with resetsAt holds the queue until the reset, then sends", async () => {
  const reset = 1_000 + 20 * minute;
  // The person chose to resume at the reset.
  const { h, providerSends, close } = await codexThread(
    hitLimit(reset),
    carriesOn,
    "resume_at_reset",
  );
  try {
    const id = await h.create();
    expect(h.store.getThread(id)?.status.state).toBe("limited");
    await h.engine.flush();
    // With no new message, the chosen reset timer still holds.
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit", resumeAt: reset });
    h.clock.advance(reset - 1);
    await h.engine.flush();
    expect(providerSends()).toBe(1);
    h.clock.advance(reset);
    await h.engine.flush();
    // Only the continuation reaches Codex.
    expect(providerSends()).toBe(2);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

test("under the manual policy a reset clears the limit but sends nothing until the person resumes", async () => {
  const reset = 1_000 + 20 * minute;
  const { h, providerSends, close } = await codexThread(clearedThen(reset, 2));
  try {
    const id = await h.create();
    await h.engine.flush();
    // No resume is promised: ace never starts a turn by itself.
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit", resumeAt: null });
    h.clock.advance(reset);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).not.toBe("limited");
    expect(h.engine.queue(id)).toMatchObject({ paused: true, messages: [] });
    expect(providerSends()).toBe(1);
    expect(resume(h, id).ok).toBe(true);
    await h.engine.flush();
    expect(providerSends()).toBe(2);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  } finally {
    await close();
  }
});

test("after a cleared limit the person's next message is the go-ahead", async () => {
  const reset = 1_000 + 20 * minute;
  const { h, providerSends, close } = await codexThread(clearedThen(reset, 1));
  try {
    const id = await h.create();
    h.clock.advance(reset);
    await h.engine.flush();
    expect(providerSends()).toBe(1);
    h.command({ type: "thread.send", threadId: id, input: text("carry on") });
    await h.engine.flush();
    expect(providerSends()).toBe(2);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

test("a fresh usage reading below the limit clears a limited account and its thread's limit", async () => {
  const reset = 1_000 + 25 * minute;
  const { h, registry, providerSends, close } = await codexThread(clearedThen(reset, 2));
  try {
    const id = await h.create();
    await h.engine.flush();
    expect(registry.summary("account-a", h.clock.now())?.availability).toBe("exhausted");
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
    // Codex re-read the account early (a banked reset was redeemed): it has room now.
    h.clock.advance(1_000 + 5 * minute);
    registry.ingest("account-a", {
      provider: "codex",
      payload: new ProviderPayload(
        JSON.stringify({
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: reset / 1000 },
            },
          },
        }),
      ),
      observedAt: h.clock.now(),
      timeZone: "UTC",
    });
    await h.engine.flush();
    expect(registry.summary("account-a", h.clock.now())?.availability).toBe("available");
    expect(h.store.getThread(id)?.status.state).not.toBe("limited");
    // The limit is gone, but ace starts no turn until the person resumes.
    expect(providerSends()).toBe(1);
    expect(h.engine.queue(id)).toMatchObject({
      paused: true,
      messages: [],
    });
    expect(resume(h, id).ok).toBe(true);
    await h.engine.flush();
    expect(providerSends()).toBe(2);
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

test("a new message retries Codex before its account reset and cancels the scheduled resume", async () => {
  const reset = 1_000 + 20 * minute;
  const { h, providerSends, close } = await codexThread(
    clearedThen(reset, 1),
    carriesOn,
    "resume_at_reset",
  );
  try {
    const id = await h.create();
    expect(h.engine.queue(id)).toMatchObject({ paused: true, resumeAt: reset });
    h.command({ type: "thread.send", threadId: id, input: text("try now") });
    await h.engine.flush();
    expect(providerSends()).toBe(2);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, resumeAt: null, messages: [] });
    expect(h.store.getThread(id)?.status.state).toBe("done");
    h.clock.advance(reset);
    await h.engine.flush();
    expect(providerSends()).toBe(2);
  } finally {
    await close();
  }
});
