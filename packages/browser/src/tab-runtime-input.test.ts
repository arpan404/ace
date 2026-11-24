import { describe, expect, it } from "vitest";
import { ThreadId, type BrowserState } from "@ace/protocol";
import type { BrowserBackendPage, BrowserBackendSession, BrowserCdp } from "./backend.ts";
import { collaborationTiming } from "./collaboration.ts";
import type { SessionLogs } from "./logs.ts";
import type { NavigationPolicies } from "./policy-waits.ts";
import { QueueBudget } from "./session-queue.ts";
import type { SessionOptions } from "./session-options.ts";
import { TabRuntime, type TabHost } from "./tab-runtime.ts";

function fakeCdp() {
  const calls: { method: string; params: unknown }[] = [];
  const cdp: BrowserCdp = {
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return {};
    },
    on: () => {},
    off: () => {},
  };
  return { cdp, calls };
}

function fakePage(cdp: BrowserCdp): BrowserBackendPage {
  return {
    cdp,
    url: () => "https://example.com/",
    navigate: async () => {},
    click: async () => {},
    insertText: async () => {},
    press: async () => {},
    wheel: async () => {},
    screenshot: async () => Buffer.from([]),
    resize: async () => {},
    viewport: () => ({ width: 5120, height: 3200 }),
    media: async () => {},
  };
}

function hostFor(page: BrowserBackendPage, inputScale?: number): TabHost {
  const options = {
    threadId: ThreadId.parse("tab-input-test"),
    backend: {} as unknown as BrowserBackendSession,
    backendKind: "embedded",
    dir: "/tmp/tab-input-test",
    now: () => 1_000,
    id: () => "id-1",
    navigationClock: { now: () => 1_000, set: () => () => {} },
    cancelPolicy: () => {},
    navigatePolicy: async () => true,
    artifact: () => {},
    state: () => {},
    cleanup: async () => {},
  } satisfies SessionOptions;
  return {
    options,
    logs: {} as unknown as SessionLogs,
    policies: {} as unknown as NavigationPolicies,
    budget: new QueueBudget(),
    timing: collaborationTiming,
    page: () => page,
    flags: () => ({ closed: false, paused: false, pageStateLost: false }),
    dialog: () => undefined,
    listed: () => undefined,
    answer: async () => {},
    blocked: () => undefined,
    blockedNavigation: () => {},
    clearBlocked: () => {},
    state: () => ({}) as unknown as BrowserState,
    emit: () => {},
    privacyChanged: () => {},
    wake: async () => {},
    beginRecording: async () => {},
    finishRecording: async () => {
      throw new Error("unused");
    },
    annotation: () => {},
    ...(inputScale === undefined ? {} : { inputScale: () => inputScale }),
  };
}

function dispatched(calls: { method: string; params: unknown }[], method: string, type: string) {
  const found = calls.filter(
    (call) =>
      call.method === method &&
      typeof call.params === "object" &&
      call.params !== null &&
      (call.params as Record<string, unknown>).type === type,
  );
  expect(found).toHaveLength(1);
  return found[0]?.params as Record<string, unknown>;
}

describe("the person's input on a fitted page", () => {
  it("reaches Chrome in CSS pixels", async () => {
    const { cdp, calls } = fakeCdp();
    const runtime = new TabRuntime(hostFor(fakePage(cdp), 1.25), "tab-1");
    // The fitted center of a 5120x3200 page: (2048, 1280) maps to (2560, 1600).
    await runtime.input({ kind: "mouse", event: "mousePressed", x: 2048, y: 1280 }, "conn-1");
    expect(dispatched(calls, "Input.dispatchMouseEvent", "mousePressed")).toMatchObject({
      type: "mousePressed",
      x: 2560,
      y: 1600,
    });
    await runtime.input({ kind: "scroll", x: 2048, y: 1280, deltaX: 0, deltaY: 100 }, "conn-1");
    expect(dispatched(calls, "Input.dispatchMouseEvent", "mouseWheel")).toMatchObject({
      type: "mouseWheel",
      x: 2560,
      y: 1600,
      deltaX: 0,
      deltaY: 100,
    });
    await runtime.input(
      {
        kind: "touch",
        event: "touchStart",
        points: [
          { x: 2048, y: 1280, id: 0 },
          { x: 2000, y: 1200, id: 1 },
        ],
      },
      "conn-1",
    );
    expect(dispatched(calls, "Input.dispatchTouchEvent", "touchStart")).toMatchObject({
      type: "touchStart",
      touchPoints: [
        { x: 2560, y: 1600, id: 0 },
        { x: 2500, y: 1500, id: 1 },
      ],
    });
  });

  it("goes through unchanged without a fitted page", async () => {
    const { cdp, calls } = fakeCdp();
    const runtime = new TabRuntime(hostFor(fakePage(cdp)), "tab-1");
    await runtime.input({ kind: "mouse", event: "mousePressed", x: 2048, y: 1280 }, "conn-1");
    expect(dispatched(calls, "Input.dispatchMouseEvent", "mousePressed")).toMatchObject({
      type: "mousePressed",
      x: 2048,
      y: 1280,
    });
  });
});
