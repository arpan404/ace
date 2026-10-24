import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { lineReader } from "@ace/provider-kit/process";
import { z } from "zod";
import {
  ScreenInventory,
  ScreenTarget,
  ScreenUIActResult,
  ScreenUIFindResult,
  ScreenUITree,
} from "@ace/protocol";
import { Helper, windowsEndpoint, type Frame } from "./index.ts";
const HelperEnv = z.object({ ACE_WINDOWS_SCREEN_HELPER: z.string().min(1) });
const SystemEnv = z.object({ SystemRoot: z.string().min(1) });
const FixtureLine = z.object({
  hwnd: z.number().int().positive(),
  visible: z.boolean(),
  dwmStatus: z.number().int(),
  session: z.number().int().nonnegative(),
});
const Allowlist = z.array(z.string().min(1).max(256));

function unstartedLines(error: Error): void {
  throw error;
}

function nextId() {
  let count = 0;
  return () => {
    count += 1;
    return `owned-${count}`;
  };
}

function isJpeg(payload: Buffer): boolean {
  if (payload.length < 4) return false;
  const head = payload.readUInt16BE(0) === 0xffd8;
  const tail = payload.readUInt16BE(payload.length - 2) === 0xffd9;
  return head && tail;
}

function findRefInTree(node: unknown, wanted: string): string | undefined {
  const parsed = z
    .object({
      ref: z.string(),
      name: z.string(),
      value: z.string().optional(),
      children: z.array(z.unknown()),
    })
    .safeParse(node);
  if (parsed.success === false) return undefined;
  if (parsed.data.name === wanted || parsed.data.value === wanted) return parsed.data.ref;
  for (const child of parsed.data.children) {
    const found = findRefInTree(child, wanted);
    if (found !== undefined) return found;
  }
  return undefined;
}

it.runIf(process.platform === "win32")(
  "owned Windows form captures JPEG, edits Unicode through UIA and repaints pixels",
  async () => {
    const helperPath = HelperEnv.parse(process.env).ACE_WINDOWS_SCREEN_HELPER;
    const systemRoot = SystemEnv.parse(process.env).SystemRoot;
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const fixture = fileURLToPath(new URL("./testing/windows-edit-fixture.ps1", import.meta.url));
    const title = `ace-owned-${randomUUID()}`;
    const child = spawn(powershell, ["-NoProfile", "-Sta", "-File", fixture], {
      env: { ...process.env, ACE_OWNED_TITLE: title },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    onTestFinished(async () => {
      child.kill();
      await closed;
    });
    const stdout = child.stdout;
    if (stdout === null) {
      child.kill();
      await closed;
      throw new Error("Fixture has no stdout");
    }
    let failLines: (error: Error) => void = unstartedLines;
    const lines = lineReader(stdout, 64 * 1024, (error: Error) => failLines(error));
    let helper: Helper | undefined;
    let fixtureFacts = "";
    try {
      const hwnd = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 30_000);
        failLines = (error: Error) => {
          clearTimeout(timer);
          child.kill();
          reject(error);
        };
        child.once("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", () => {
          clearTimeout(timer);
          reject(new Error(`Fixture exited before reporting HWND: ${stderr}`));
        });
        lines.on("line", (line: string) => {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return;
          }
          const parsed = FixtureLine.safeParse(raw);
          if (parsed.success) {
            fixtureFacts = JSON.stringify(parsed.data);
            clearTimeout(timer);
            resolve(parsed.data.hwnd);
          }
        });
      });
      const frames: Frame[] = [];
      const failures: Error[] = [];
      const listeners: Array<() => void> = [];
      const notify = () => {
        const pending = listeners.splice(0, listeners.length);
        for (const listener of pending) listener();
      };
      helper = await Helper.open({
        command: helperPath,
        platform: "win32",
        endpoint: windowsEndpoint(randomUUID()),
        nextId: nextId(),
        onFrame: (frame: Frame) => {
          frames.push(frame);
          notify();
        },
        onFailure: (error: Error) => {
          failures.push(error);
          notify();
        },
      });
      const waitFrame = (from: number, timeoutMs: number, different: Buffer | undefined) =>
        new Promise<Frame>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Frame deadline elapsed")), timeoutMs);
          const poll = () => {
            if (failures.length > 0) {
              clearTimeout(timer);
              reject(new Error("Helper exited during frame wait"));
              return;
            }
            for (let index = from; index < frames.length; index += 1) {
              const frame = frames[index];
              if (frame === undefined) continue;
              if (different !== undefined && Buffer.compare(frame.payload, different) === 0)
                continue;
              clearTimeout(timer);
              resolve(frame);
              return;
            }
            listeners.push(poll);
          };
          poll();
        });
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      const owned = inventory.windows.find((entry) => entry.windowId === hwnd);
      if (owned === undefined)
        throw new Error(
          `Owned window missing from ${inventory.windows.length} visible targets: ${fixtureFacts}`,
        );
      const target = ScreenTarget.parse({
        kind: "window",
        bundleId: owned.bundleId,
        windowId: hwnd,
      });
      const allowlist = Allowlist.parse([owned.bundleId]);
      await helper.request({ op: "start", sessionId: "ownedcap1", target, allowlist, fps: 10 });
      const first = await waitFrame(0, 30_000, undefined);
      expect(first.header.width).toBeGreaterThan(0);
      expect(first.header.height).toBeGreaterThan(0);
      expect(isJpeg(first.payload)).toBe(true);
      const tree = ScreenUITree.parse(
        await helper.request({ op: "ui.tree", target, allowlist, maxDepth: 8, maxNodes: 128 }),
      );
      const fromTree = tree.root === null ? undefined : findRefInTree(tree.root, "OwnedEdit");
      const found = ScreenUIFindResult.parse(
        await helper.request({
          op: "ui.find",
          target,
          allowlist,
          query: { name: "OwnedEdit" },
          limit: 8,
        }),
      );
      const ref = found.nodes[0]?.ref ?? fromTree;
      if (ref === undefined) throw new Error("Owned textbox was not found");
      expect(found.nodes[0]?.actions).toContain("setValue");
      const repaintFrom = frames.length;
      const value = "Hello \u4f60\u597d \ud83d\ude00";
      const acted = ScreenUIActResult.parse(
        await helper.request({ op: "ui.act", target, allowlist, ref, action: "setValue", value }),
      );
      expect(acted.fallback).toBe(false);
      const reread = ScreenUIFindResult.parse(
        await helper.request({
          op: "ui.find",
          target,
          allowlist,
          query: { text: value },
          limit: 8,
        }),
      );
      expect(reread.nodes.some((node) => node.value === value)).toBe(true);
      const repainted = await waitFrame(repaintFrom, 30_000, first.payload);
      expect(repainted.header.width).toBeGreaterThan(0);
      expect(repainted.header.height).toBeGreaterThan(0);
      expect(isJpeg(repainted.payload)).toBe(true);
      expect(Buffer.compare(repainted.payload, first.payload) === 0).toBe(false);
      await helper.request({ op: "stop" });
      expect(await helper.request({ op: "permissions" })).toBeDefined();
      expect(failures).toEqual([]);
    } finally {
      lines.close();
      if (helper !== undefined) await helper.close();
      child.kill();
      await closed;
    }
  },
  120_000,
);
