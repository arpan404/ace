import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSupervised } from "@ace/provider-kit/process";
import { expect, it } from "vitest";
import { Recording, type Frame } from "./recording.ts";
import { createRecordedPeer } from "./stdio.ts";

it("keeps recorder JSONL channels, raw payloads and process exit notes unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-kit-recording-test-"));
  const path = join(root, "frames.jsonl");
  const rec = new Recording(path, {
    format: "ace-recording/v1",
    provider: "synthetic",
    cliVersion: "1",
    scenario: "test",
    startedAt: "2026-10-02",
    platform: "test",
    workspace: "synthetic",
  });
  const proc = spawnSupervised({
    command: process.execPath,
    args: [
      "-e",
      `
    require('node:readline').createInterface({input:process.stdin}).once('line', line => {
      const m = JSON.parse(line);
      console.log('plain diagnostic');
      console.log(JSON.stringify({id:m.id,result:{answer:'tabs'}}));
      console.error('stderr diagnostic');
      process.stdin.destroy();
    });
  `,
    ],
    env: {},
    name: "synthetic-recorder",
  });
  try {
    const rpc = createRecordedPeer(proc, rec);
    expect(await rpc.request("echo", { prompt: "hello" })).toEqual({ answer: "tabs" });
    await proc.exited;
    await rec.close();
    const frames = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line) as Frame);
    expect(frames.map(({ dir, channel, data }) => ({ dir, channel, data }))).toEqual(
      expect.arrayContaining([
        {
          dir: "send",
          channel: "stdio",
          data: { jsonrpc: "2.0", id: 1, method: "echo", params: { prompt: "hello" } },
        },
        { dir: "recv", channel: "stdio-text", data: "plain diagnostic" },
        { dir: "recv", channel: "stdio", data: { id: 1, result: { answer: "tabs" } } },
        { dir: "stderr", channel: "stdio", data: "stderr diagnostic" },
        {
          dir: "note",
          channel: "recorder",
          data: { event: "process-exit", detail: { code: 0, signal: null } },
        },
      ]),
    );
    expect(frames).toHaveLength(5);
    expect(frames.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(frames.every((frame) => typeof frame.t === "number" && frame.t >= 0)).toBe(true);
  } finally {
    await proc.stop({ graceMs: 0 });
    await rm(root, { recursive: true, force: true });
  }
});
