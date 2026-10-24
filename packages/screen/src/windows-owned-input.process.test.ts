import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { lineReader } from "@ace/provider-kit/process";
import { z } from "zod";
import { ScreenInventory, ScreenTarget, ScreenUIFindResult } from "@ace/protocol";
import { Helper, windowsEndpoint } from "./index.ts";
import { spawnWindowsHelper } from "./windows-process.ts";

const HelperEnv = z.object({ ACE_WINDOWS_SCREEN_HELPER: z.string().min(1) });
const SystemEnv = z.object({ SystemRoot: z.string().min(1) });
const StartupLine = z.object({
  main: z.number().int().positive(),
  decoy: z.number().int().positive(),
  visible: z.boolean(),
  session: z.number().int().nonnegative(),
});
const ForegroundLine = z.object({
  foreground: z.number().int().positive(),
  which: z.enum(["main", "decoy", "snapshot"]),
  mainText: z.string().max(512),
  decoyText: z.string().max(512),
  count: z.string().max(16),
});
const Allowlist = z.array(z.string().min(1).max(256));

function center(bounds: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
} {
  return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
}

it.runIf(process.platform === "win32")(
  "owned Windows form accepts pointer, Unicode text and keys only in its own foreground",
  async () => {
    const helperPath = HelperEnv.parse(process.env).ACE_WINDOWS_SCREEN_HELPER;
    const systemRoot = SystemEnv.parse(process.env).SystemRoot;
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const fixture = fileURLToPath(
      new URL("./testing/windows-owned-input-fixture.ps1", import.meta.url),
    );
    const title = `ace-owned-input-${randomUUID()}`;
    const child = spawn(powershell, ["-NoProfile", "-Sta", "-File", fixture], {
      env: { ...process.env, ACE_OWNED_TITLE: title, ACE_OWNED_DECOY: `${title}-decoy` },
      stdio: ["pipe", "pipe", "pipe"],
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
    const lines = lineReader(stdout, 64 * 1024, () => child.kill());
    let helper: Helper | undefined;
    try {
      const started = await new Promise<z.infer<typeof StartupLine>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 30_000);
        child.once("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", () => {
          clearTimeout(timer);
          reject(new Error(`Fixture exited before startup: ${stderr}`));
        });
        lines.on("line", (line: string) => {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return;
          }
          const parsed = StartupLine.safeParse(raw);
          if (parsed.success) {
            clearTimeout(timer);
            resolve(parsed.data);
          }
        });
      });
      const stdin = child.stdin;
      if (stdin === null) throw new Error("Fixture has no stdin");
      stdin.on("error", () => {});
      const foreground = (which: "main" | "decoy" | "snapshot", wanted: number) =>
        new Promise<z.infer<typeof ForegroundLine>>((resolve, reject) => {
          const timer = setTimeout(() => {
            lines.removeListener("line", onLine);
            reject(new Error(`Foreground ${which} timed out: ${stderr}`));
          }, 30_000);
          const onLine = (line: string) => {
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              return;
            }
            const parsed = ForegroundLine.safeParse(raw);
            if (!parsed.success || parsed.data.which !== which) return;
            clearTimeout(timer);
            lines.removeListener("line", onLine);
            if (parsed.data.foreground !== wanted) {
              reject(new Error(`Foreground ${which} refused: ${JSON.stringify(parsed.data)}`));
              return;
            }
            resolve(parsed.data);
          };
          lines.on("line", onLine);
          stdin.write(`${which}\n`, (error: Error | undefined | null) => {
            if (error) {
              clearTimeout(timer);
              lines.removeListener("line", onLine);
              reject(error);
            }
          });
        });
      const failures: Error[] = [];
      let nativeStderr = "";
      helper = await Helper.open({
        spawn: (options) => {
          const proc = spawnWindowsHelper(options);
          proc.stderr.on("line", (line: string) => {
            nativeStderr = (nativeStderr + line + "\n").slice(-4096);
          });
          return proc;
        },
        command: helperPath,
        platform: "win32",
        endpoint: windowsEndpoint(randomUUID()),
        nextId: (() => {
          let count = 0;
          return () => {
            count += 1;
            return `ownedinput-${count}`;
          };
        })(),
        onFrame: () => {},
        onFailure: (error) => failures.push(error),
      });
      const inventory = ScreenInventory.parse(await helper.request({ op: "targets" }));
      const owned = inventory.windows.find((entry) => entry.windowId === started.main);
      if (owned === undefined) throw new Error(`Owned main missing: ${JSON.stringify(started)}`);
      const decoy = inventory.windows.find((entry) => entry.windowId === started.decoy);
      if (decoy === undefined) throw new Error(`Owned decoy missing: ${JSON.stringify(started)}`);
      const target = ScreenTarget.parse({
        kind: "window",
        bundleId: owned.bundleId,
        windowId: started.main,
      });
      const allowlist = Allowlist.parse([owned.bundleId]);
      await helper.request({ op: "start", sessionId: "ownedinput1", target, allowlist, fps: 10 });
      await foreground("main", started.main);
      const live = helper;
      const findByName = async (name: string) => {
        const found = ScreenUIFindResult.parse(
          await live.request({ op: "ui.find", target, allowlist, query: { name }, limit: 8 }),
        );
        const node = found.nodes[0];
        if (node === undefined) throw new Error(`UI node ${name} missing`);
        return node;
      };
      const edit = await findByName("OwnedEdit");
      const editAt = center(edit.bounds);
      await helper.request({
        op: "input",
        input: { kind: "pointer.click", x: editAt.x, y: editAt.y, button: "left" },
      });
      await helper.request({
        op: "input",
        input: { kind: "key.press", key: "A", modifiers: ["control"] },
      });
      await helper.request({
        op: "input",
        input: { kind: "key.press", key: "Backspace", modifiers: [] },
      });
      const sentinel = "Hello \u4f60\u597d \ud83d\ude00";
      await helper.request({ op: "input", input: { kind: "text.type", text: sentinel } });
      await expect.poll(async () => (await findByName("OwnedEdit")).value).toBe(sentinel);
      expect((await findByName("OwnedCount")).value).toBe("0");
      const button = await findByName("OwnedButton");
      const buttonAt = center(button.bounds);
      await helper.request({
        op: "input",
        input: { kind: "pointer.click", x: buttonAt.x, y: buttonAt.y, button: "left" },
      });
      await expect.poll(async () => (await findByName("OwnedCount")).value).toBe("1");
      await foreground("decoy", started.decoy);
      await expect(
        helper.request({
          op: "input",
          input: { kind: "pointer.click", x: buttonAt.x, y: buttonAt.y, button: "left" },
        }),
      ).rejects.toMatchObject({ code: "busy" });
      await expect(
        helper.request({ op: "input", input: { kind: "text.type", text: "must-not-arrive" } }),
      ).rejects.toMatchObject({ code: "busy" });
      const refused = await foreground("snapshot", started.decoy);
      expect(refused).toMatchObject({ mainText: sentinel, decoyText: "decoy", count: "1" });
      expect((await findByName("OwnedEdit")).value).toBe(sentinel);
      expect((await findByName("OwnedCount")).value).toBe("1");
      await foreground("main", started.main);
      const again = await findByName("OwnedButton");
      const againAt = center(again.bounds);
      await helper.request({
        op: "input",
        input: { kind: "pointer.click", x: againAt.x, y: againAt.y, button: "left" },
      });
      await expect.poll(async () => (await findByName("OwnedCount")).value).toBe("2");
      expect(failures, nativeStderr).toEqual([]);
      await helper.request({ op: "stop" });
    } finally {
      lines.close();
      try {
        if (helper !== undefined) await helper.close();
      } finally {
        child.kill();
        await closed;
      }
    }
  },
);
