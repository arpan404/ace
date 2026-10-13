import { expect, test, vi } from "vitest";
import { ThreadId, type PreviewSuggestion } from "@ace/protocol";
import type { Listener } from "@ace/preview/detection";
import type { PageFacts } from "./page-probe.ts";
import { SuggestionTracker } from "./tracker.ts";

const thread = ThreadId.parse("thread-a");
const daemon = 100;
const shell = 200;

/** A machine the test edits: listeners, page answers, a clock and timers fired by hand. */
function machine() {
  let now = 1_000;
  const listeners: Listener[] = [];
  const pages = new Map<number, PageFacts>();
  const feeds = new Map<string, (stream: string, chunk: string) => void>();
  const waits = new Set<() => void>();
  let scans = 0;
  const pushes: PreviewSuggestion[][] = [];
  const tracker = new SuggestionTracker({
    now: () => now,
    daemon,
    daemonPorts: () => new Set(),
    leaseMs: 10_000,
    wait: (_ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          waits.delete(done);
          resolve();
        };
        waits.add(done);
        signal.addEventListener("abort", done, { once: true });
      }),
    io: {
      listeners: async () => {
        scans++;
        return [...listeners];
      },
      parents: async () =>
        new Map([
          [shell, daemon],
          [201, shell],
          [500, 1],
        ]),
      cwds: async () => new Map([[500, "/elsewhere"]]),
      probe: async (port) => pages.get(port) ?? { http: false },
      scope: async (threadId) => ({ threadId, roots: ["/work/app"], shells: [shell] }),
      follow: (threadId, feed) => {
        feeds.set(threadId, feed);
        return () => feeds.delete(threadId);
      },
    },
  });
  return {
    tracker,
    listeners,
    pages,
    pushes,
    scans: () => scans,
    advance: (milliseconds: number) => (now += milliseconds),
    print: (text: string) => feeds.get(thread)?.("terminal:1", text),
    following: () => feeds.has(thread),
    /** Let the next scan run. */
    tick: () => {
      for (const resolve of waits) resolve();
    },
    watch: () => tracker.watch("socket-1", thread, (list) => pushes.push([...list])),
  };
}

test("a printed address is suggested once its port listens, then dropped when it stops", async () => {
  const m = machine();
  expect(await m.watch()).toEqual([]);
  m.print("  ➜  Local:   http://localhost:5173/app/\r\n");
  m.listeners.push({ pid: 201, port: 5173, reach: "loopback" });
  m.pages.set(5173, { http: true, title: "Vite App", iconUrl: "data:image/png;base64,AA==" });
  // The printed address wakes the scan without waiting out the poll delay.
  await vi.waitFor(() => expect(m.pushes).toHaveLength(1));
  expect(m.pushes[0]).toEqual([
    {
      port: 5173,
      url: "http://localhost:5173/app/",
      title: "Vite App",
      iconUrl: "data:image/png;base64,AA==",
      source: "terminal",
    },
  ]);
  expect(m.tracker.suggestions(thread)).toEqual(m.pushes[0]);

  m.listeners.splice(0);
  m.tick();
  await vi.waitFor(() => expect(m.pushes).toHaveLength(2));
  expect(m.pushes[1]).toEqual([]);
  m.tracker.close();
});

test("a listener found by scanning is suggested at its plain address; non-HTTP ones never are", async () => {
  const m = machine();
  m.listeners.push(
    { pid: 201, port: 3000, reach: "any" },
    { pid: 201, port: 5432, reach: "loopback" },
    { pid: 500, port: 8080, reach: "loopback" },
  );
  m.pages.set(3000, { http: true });
  m.pages.set(8080, { http: true, title: "Another project" });
  expect(await m.watch()).toEqual([
    { port: 3000, url: "http://localhost:3000/", source: "listener" },
  ]);
  m.tracker.close();
});

test("detection stops scanning and following output once nobody watches the thread", async () => {
  const m = machine();
  await m.watch();
  expect(m.following()).toBe(true);
  m.advance(10_001);
  m.tick();
  await vi.waitFor(() => expect(m.following()).toBe(false));
  const scans = m.scans();
  m.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(m.scans()).toBe(scans);

  // Watching again starts over.
  await m.watch();
  expect(m.following()).toBe(true);
  expect(m.scans()).toBeGreaterThan(scans);
  m.tracker.release("socket-1");
  expect(m.following()).toBe(false);
  m.tracker.close();
});
