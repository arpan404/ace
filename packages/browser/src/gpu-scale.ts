import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import { chromiumProcessKiller } from "./chromium-process.ts";

/*
 * Windows machines without a usable GPU (virtual machines, remote sessions, blocklisted
 * drivers) composite and rasterize ace's Chrome on the CPU. At device scale 2 a 1280 × 800 tab
 * is 2560 × 1600 pixels a frame, and with tab capture running it draws 30–40 fps on such a
 * machine; at scale 1 it draws 60 (measured on GitHub's x64 and ARM64 Windows runners). Live
 * views keep 60 fps and cost resolution instead (ADR 0088, amended). Machines whose Chrome
 * composites on the GPU keep scale 2.
 */

const GpuInfo = z.object({
  gpu: z.object({
    devices: z
      .array(z.looseObject({ vendorId: z.number().optional(), deviceId: z.number().optional() }))
      .default([]),
    featureStatus: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Microsoft's software rasterizer (WARP), which Windows reports when no GPU driver is usable. */
const basicRender = { vendorId: 0x1414, deviceId: 0x8c };

/** Whether Chrome's `SystemInfo.getInfo` says it draws without a GPU. Unknown input: no. */
export function softwareCompositing(info: unknown): boolean {
  const parsed = GpuInfo.safeParse(info);
  if (!parsed.success) return false;
  const { devices, featureStatus } = parsed.data.gpu;
  const compositing = featureStatus?.["gpu_compositing"];
  if (typeof compositing === "string" && compositing !== "enabled") return true;
  return (
    devices.length > 0 &&
    devices.every(
      (device) =>
        device.vendorId === basicRender.vendorId && device.deviceId === basicRender.deviceId,
    )
  );
}

/** ace's Chrome's device scale on Windows: 1 where it draws without a GPU, else `preferred`. */
export function windowsDeviceScale(info: unknown, preferred: number): number {
  return softwareCompositing(info) ? 1 : preferred;
}

const Reply = z.object({ id: z.number(), result: z.unknown().optional() });

/**
 * Windows: starts the browser once, headless over its pipe, and returns its GPU report
 * (`SystemInfo.getInfo`); undefined when it doesn't answer within `timeoutMs`.
 */
export async function probeChromeGpu(
  executable: string,
  timeoutMs = 15_000,
): Promise<unknown | undefined> {
  const profile = await mkdtemp(join(tmpdir(), "ace-gpu-probe-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-startup-window",
      "--disable-audio-output",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const input = child.stdio[3];
  const output = child.stdio[4];
  try {
    if (!(input instanceof Writable) || !(output instanceof Readable)) return undefined;
    input.on("error", () => {});
    const info = await new Promise<unknown | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      let pending = "";
      output.on("data", (chunk: Buffer) => {
        pending = (pending + chunk.toString("utf8")).slice(-4 * 1024 * 1024);
        const messages = pending.split("\0");
        pending = messages.pop() ?? "";
        for (const message of messages) {
          const reply = Reply.safeParse(parseJson(message));
          if (!reply.success || reply.data.id !== 1) continue;
          clearTimeout(timer);
          resolve(reply.data.result);
        }
      });
      void exited.then(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
      input.write(`${JSON.stringify({ id: 1, method: "SystemInfo.getInfo" })}\0`);
    });
    input.write(`${JSON.stringify({ id: 2, method: "Browser.close" })}\0`);
    return info;
  } finally {
    const forced = setTimeout(() => {
      if (child.pid !== undefined) void chromiumProcessKiller("win32")(child.pid).catch(() => {});
    }, 5_000);
    await exited;
    clearTimeout(forced);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      () => {},
    );
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
