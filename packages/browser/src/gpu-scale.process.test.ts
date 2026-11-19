import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { expect, it } from "vitest";
import { softwareCompositing } from "./gpu-scale.ts";
import { executablePath, fixture } from "./test-support.ts";

/** The test's own look at this machine's GPU: a headless Chrome's `SystemInfo.getInfo`. */
async function gpuReport(executable: string): Promise<unknown> {
  const profile = await mkdtemp(join(tmpdir(), "ace-gpu-report-"));
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--do-not-de-elevate",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true },
  );
  try {
    const input = child.stdio[3] as Writable;
    const output = child.stdio[4] as Readable;
    let text = "";
    const report = new Promise<unknown>((resolve) =>
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const reply = text.split("\0").find((message) => message.startsWith('{"id":1,'));
        if (reply) resolve((JSON.parse(reply) as { result: unknown }).result);
      }),
    );
    input.write(`${JSON.stringify({ id: 1, method: "SystemInfo.getInfo" })}\0`);
    const gpu = await report;
    input.write(`${JSON.stringify({ id: 2, method: "Browser.close" })}\0`);
    return gpu;
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

it.runIf(process.platform === "win32" && executablePath)(
  "Windows: ace's Chrome draws at device scale 1 where it has no GPU and 2 where it has one",
  async () => {
    const gpu = await gpuReport(executablePath ?? "");
    const f = await fixture();
    await f.navigate();
    expect(await f.evaluate("devicePixelRatio")).toBe(softwareCompositing(gpu) ? 1 : 2);
  },
  90_000,
);

it.runIf(process.platform === "win32" && executablePath)(
  "Windows: an embedder's chosen device scale is kept whatever the GPU",
  async () => {
    const f = await fixture({ chrome: { deviceScaleFactor: 2 } });
    await f.navigate();
    expect(await f.evaluate("devicePixelRatio")).toBe(2);
  },
  90_000,
);
