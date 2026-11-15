import { describe, expect, it } from "vitest";
import { waitForDaemon, type EndpointWatch, type ReadinessPorts } from "./readiness.ts";
import { local } from "./supervisor-test-support.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A home whose daemon publishes its endpoint when the test says, on a fake clock. */
function home(options: { watched: boolean }) {
  let now = 0;
  let published = false;
  let ready = true;
  let lookups = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  let notify: (() => void) | undefined;
  const watch: EndpointWatch = {
    changed: () => new Promise((resolve) => (notify = resolve)),
    close: () => (notify = undefined),
  };
  const ports: ReadinessPorts = {
    find: async () => {
      lookups++;
      return published && ready ? local : undefined;
    },
    watchEndpoint: options.watched ? () => watch : undefined,
    maintenance: async () => ({ draining: false }),
    timers: {
      set(delayMs, callback) {
        const timer = { at: now + delayMs, callback };
        timers.add(timer);
        return () => timers.delete(timer);
      },
    },
    now: () => now,
    log: () => {},
  };
  return {
    ports,
    lookups: () => lookups,
    notReady: () => void (ready = false),
    ready: () => void (ready = true),
    now: () => now,
    async publish() {
      published = true;
      notify?.();
      await settle();
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        await settle();
        const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = until;
      await settle();
    },
  };
}

describe("waiting for a starting daemon", () => {
  it("finds it as soon as it publishes its endpoint, without polling in between", async () => {
    const h = home({ watched: true });
    let found: unknown;
    void waitForDaemon(h.ports, 60_000, () => true).then((daemon) => (found = daemon));
    await h.advance(950);
    // One lookup at the start; nothing changed since, so nothing more is read.
    expect(h.lookups()).toBe(1);
    await h.publish();
    expect(found).toEqual(local);
    expect(h.now()).toBe(950);
  });

  it("polls every 200 ms once the endpoint is published, for a daemon not ready yet", async () => {
    const h = home({ watched: true });
    let found: unknown;
    void waitForDaemon(h.ports, 60_000, () => true).then((daemon) => (found = daemon));
    await h.advance(500);
    // Published but still starting: its status does not count yet, and readiness changes no file.
    h.notReady();
    await h.publish();
    const after = h.lookups();
    await h.advance(600);
    expect(h.lookups()).toBe(after + 3);
    h.ready();
    await h.advance(200);
    expect(found).toEqual(local);
  });

  it("still looks again every second when the watch reports nothing", async () => {
    const h = home({ watched: true });
    void waitForDaemon(h.ports, 60_000, () => true);
    await h.advance(3_000);
    expect(h.lookups()).toBe(4);
  });

  it("polls every 200 ms where the endpoint cannot be watched", async () => {
    const h = home({ watched: false });
    let found: unknown;
    void waitForDaemon(h.ports, 60_000, () => true).then((daemon) => (found = daemon));
    await h.advance(1_000);
    expect(h.lookups()).toBe(6);
    await h.publish();
    await h.advance(200);
    expect(found).toEqual(local);
  });
});
