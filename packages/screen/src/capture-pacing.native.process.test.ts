/*
 * Real Windows: the live-view stream (Windows Graphics Capture through the CI-built helper)
 * must end on what a window finally shows, also when it changes several times within one
 * pacing interval or is resized and then stays still. The owned fixture window
 * (`examples/computer_fixture.rs`) paints colour bursts and resizes on request. The reference
 * is a fresh capture of the still window: the last streamed frame must be the same JPEG.
 * Run by scripts/vitest-windows-screen.config.ts.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { ScreenInventory, ScreenTarget } from "@ace/protocol";
import type { Frame } from "./index.ts";
import { nativeWindowsHelper } from "./testing/owned-window.ts";

const ciWindows = process.platform === "win32" && process.env["CI"] === "true";
const windows =
  process.platform === "win32" && (ciWindows || !!process.env["ACE_WINDOWS_SCREEN_HELPER"]);
const helperPath = () => z.string().min(1).parse(process.env["ACE_WINDOWS_SCREEN_HELPER"]);
const fixturePath = () => join(dirname(helperPath()), "examples", "computer_fixture.exe");

const Line = z.looseObject({
  ready: z.boolean().optional(),
  hwnd: z.number().optional(),
  event: z.string().optional(),
});

/** Starts the fixture window and returns its handle and a way to send it commands. */
async function fixture(title: string) {
  const child = spawn(fixturePath(), ["--title", title], { stdio: ["pipe", "pipe", "pipe"] });
  onTestFinished(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });
  const lines: z.infer<typeof Line>[] = [];
  const waiting = new Set<() => void>();
  createInterface({ input: child.stdout }).on("line", (text) => {
    try {
      lines.push(Line.parse(JSON.parse(text)));
    } catch {
      return;
    }
    for (const notify of waiting) notify();
  });
  const next = (predicate: (line: z.infer<typeof Line>) => boolean) =>
    new Promise<z.infer<typeof Line>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The fixture did not answer")), 15_000);
      function notify() {
        const index = lines.findIndex(predicate);
        if (index < 0) return;
        const [line] = lines.splice(index, 1);
        clearTimeout(timer);
        waiting.delete(notify);
        if (line) resolve(line);
      }
      waiting.add(notify);
      notify();
    });
  const ready = await next((line) => line.ready === true);
  return {
    hwnd: z.number().parse(ready.hwnd),
    command: async (text: string, event: string) => {
      child.stdin.write(`${text}\n`);
      await next((line) => line.event === event);
    },
  };
}

/** The helper streaming one window, with every frame it sends. */
async function stream(hwnd: number) {
  const frames: Frame[] = [];
  const failures: Error[] = [];
  const native = await nativeWindowsHelper({
    onFrame: (frame) => frames.push(frame),
    onFailure: (error) => failures.push(error),
  });
  onTestFinished(() => native.helper.close());
  const inventory = ScreenInventory.parse(await native.helper.request({ op: "targets" }));
  const owned = inventory.windows.find((entry) => entry.windowId === hwnd);
  if (!owned) throw new Error("The fixture window is not among the capture targets");
  const target = ScreenTarget.parse({ kind: "window", bundleId: owned.bundleId, windowId: hwnd });
  const allowlist = [owned.bundleId];
  const start = (sessionId: string) =>
    native.helper.request({ op: "start", sessionId, target, allowlist, fps: 1 });
  const framesOf = (sessionId: string) =>
    frames.filter((frame) => frame.header.sessionId === sessionId);
  const firstOf = async (sessionId: string) => {
    for (let waited = 0; waited < 15_000; waited += 50) {
      const [first] = framesOf(sessionId);
      if (first) return first;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No frame for ${sessionId}; failures: ${failures.map((f) => f.message)}`);
  };
  /** A fresh capture of the window as it is now: stop, start again, take the first frame. */
  const reference = async (sessionId: string) => {
    await native.helper.request({ op: "stop" });
    await start(sessionId);
    return firstOf(sessionId);
  };
  return { start, framesOf, firstOf, reference, failures };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(windows)("Windows live-view capture", () => {
  it("Windows capture ends on the last of several changes inside one pacing interval", async () => {
    const window = await fixture(`ace-burst-${process.pid}`);
    const capture = await stream(window.hwnd);
    await capture.start("burst");
    const first = await capture.firstOf("burst");
    // Eight repaints 40 ms apart, all inside the one-second interval after the first frame,
    // then the window stays still.
    await window.command("burst 0000ff,00ff00,ff0000,ff00ff,00ffff,ffff00,808080,4000c0", "burst");
    await settle(3_000);
    const after = capture.framesOf("burst").slice(1);
    // The changes were coalesced into the pacing interval rather than streamed one by one.
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThanOrEqual(2);
    console.log(
      `burst frames: ${after.map((frame) => Math.round(frame.header.timestamp - first.header.timestamp)).join(", ")} ms after the first`,
    );
    const streamed = after.at(-1);
    const fresh = await capture.reference("burst-reference");
    expect(capture.failures).toEqual([]);
    expect(streamed && Buffer.compare(streamed.payload, fresh.payload)).toBe(0);
  }, 60_000);

  it("Windows capture sends the resized picture of a window that stays still", async () => {
    const window = await fixture(`ace-resize-${process.pid}`);
    const capture = await stream(window.hwnd);
    await capture.start("resize");
    const first = await capture.firstOf("resize");
    await settle(1_200);
    await window.command("resize 900 600", "resized");
    await settle(3_000);
    const streamed = capture.framesOf("resize").at(-1);
    const fresh = await capture.reference("resize-reference");
    expect(capture.failures).toEqual([]);
    expect(fresh.header.width).not.toBe(first.header.width);
    expect(streamed?.header.width).toBe(fresh.header.width);
    expect(streamed?.header.height).toBe(fresh.header.height);
  }, 60_000);
});
