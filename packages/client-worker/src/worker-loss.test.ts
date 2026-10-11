import { expect, test } from "vitest";
import { RemoteClient, type PortLike } from "./index.ts";
import type { Scheduler } from "@ace/client";

const noop = () => {};

function boundary() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const scheduler: Scheduler = {
    set(delay, run) {
      const timer = { at: now + delay, run };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const timer = [...timers]
        .filter((entry) => entry.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!timer) break;
      timers.delete(timer);
      now = timer.at;
      timer.run();
    }
    now = until;
  };
  let listener: ((event: { data: unknown }) => void) | undefined;
  const sent: unknown[] = [];
  const port: PortLike = {
    postMessage(message) {
      sent.push(message);
    },
    addEventListener(_type, callback) {
      listener = callback;
    },
    removeEventListener() {},
  };
  const deliver = (data: unknown) => listener?.({ data });
  let visible = true;
  let changed = noop;
  const remote = new RemoteClient(
    port,
    {},
    {
      scheduler,
      id: () => "original-id",
      visibility: {
        visible: () => visible,
        watch(callback) {
          changed = callback;
          return () => {};
        },
      },
    },
  );
  const show = (next: boolean) => {
    visible = next;
    changed();
  };
  const start = async () => {
    const attached = remote.start();
    deliver({ t: "attached", idPrefix: "tab" });
    deliver({ t: "connection", state: "ready" });
    await attached;
  };
  return { remote, start, sent, deliver, advance, show };
}

test("a lost worker invalidates cached freshness and rejects outstanding reads within their deadline", async () => {
  const h = boundary();
  await h.start();
  const request = h.remote.request({ type: "diagnostics.health" }, { timeoutMs: 5 });
  let outcome: unknown = "pending";
  void request.then(
    () => {
      outcome = "success";
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  h.advance(5);
  await expect(request).rejects.toMatchObject({ code: "timeout" });
  await Promise.resolve();
  expect(outcome).toMatchObject({ code: "timeout" });
  h.advance(60_000);
  expect(h.remote.state).toBe("fatal");
  expect(h.remote.error?.message).toContain("worker");
  // Late replies from the dead generation cannot make its cached data fresh again.
  h.deliver({ t: "connection", state: "ready" });
  expect(h.remote.state).toBe("fatal");
  await h.remote.close();
});

test("a worker that never attaches fails within a bounded time", async () => {
  const h = boundary();
  const attached = h.remote.start();
  let outcome: unknown = "pending";
  void attached.catch((error: unknown) => {
    outcome = error;
  });
  h.advance(60_000);
  await Promise.resolve();
  expect(outcome).toMatchObject({ code: "offline" });
  expect(h.remote.state).toBe("fatal");
  await h.remote.close();
});

test("a hidden tab keeps its worker client when browser timers are suspended", async () => {
  const h = boundary();
  await h.start();
  h.show(false);
  h.advance(20 * 60_000);
  expect(h.remote.state).toBe("ready");
  h.show(true);
  h.deliver({ t: "pong" });
  expect(h.remote.state).toBe("ready");
  await h.remote.close();
});
