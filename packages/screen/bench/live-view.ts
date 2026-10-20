/*
 * Live view of a Calculator window through a real helper: input → first encoded frame at the
 * daemon's frame socket, bytes on the wire, what a still picture costs and helper CPU. Presses
 * Calculator's digit buttons through the computer engine (Calculator only). Decode and paint
 * at a client are not included; native/screen-helper/bench-stream.sh measures decoded sharpness.
 *   ACE_COMPUTER_HELPER=<built helper> node packages/screen/bench/live-view.ts [presses]
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

const helper = process.env["ACE_COMPUTER_HELPER"];
if (!helper) throw new Error("Set ACE_COMPUTER_HELPER");
const presses = Number(process.argv[2] ?? "20");
const bundleId = "com.apple.calculator";
const socketPath = join(tmpdir(), `ace-lv-${process.pid}.sock`);

interface Frame {
  at: number;
  bytes: number;
  header: { keyframe?: boolean; codec: string; width: number; height: number; scale?: number };
}
const frames: Frame[] = [];
const server = createServer((socket: Socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const headerLength = buffer.readUInt32BE(0);
      if (buffer.length < 4 + headerLength) break;
      const header = JSON.parse(
        buffer.subarray(4, 4 + headerLength).toString(),
      ) as Frame["header"] & { bytes: number };
      const total = 4 + headerLength + header.bytes;
      if (buffer.length < total) break;
      frames.push({ at: performance.now(), bytes: total, header });
      buffer = buffer.subarray(total);
    }
  });
});
rmSync(socketPath, { force: true });
await new Promise<void>((resolve) => server.listen(socketPath, resolve));

function lines(child: ChildProcessWithoutNullStreams) {
  const waiting = new Map<
    string,
    (reply: { ok: boolean; result?: unknown; error?: unknown }) => void
  >();
  createInterface({ input: child.stdout }).on("line", (line) => {
    // The session helper answers with `data`, the computer engine with `result`.
    const reply = JSON.parse(line) as {
      id?: string;
      ok: boolean;
      result?: unknown;
      data?: unknown;
    };
    if (reply.id) waiting.get(reply.id)?.({ ...reply, result: reply.result ?? reply.data });
  });
  let next = 0;
  return (request: Record<string, unknown>) =>
    new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => {
      const id = String(++next);
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
}
const session = spawn(helper, ["--socket", socketPath]);
const computer = spawn(helper, ["--computer"]);
if (process.env["ACE_BENCH_DEBUG"]) session.stderr.pipe(process.stderr);
const send = lines(session);
const act = lines(computer);
const cpu = (pid: number) => {
  const [minutes, seconds] = execFileSync("ps", ["-o", "time=", "-p", String(pid)])
    .toString()
    .trim()
    .split(":");
  return Number(minutes) * 60 + Number(seconds);
};
const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0,
  );
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const targets = (await send({ version: 2, op: "targets" })).result as {
    windows: { windowId: number; bundleId: string; bounds: { width: number; height: number } }[];
  };
  const window = targets.windows.find(
    (entry) => entry.bundleId === bundleId && entry.bounds.width > 100,
  );
  if (!window) throw new Error("Calculator has no window");
  const started = await send({
    version: 2,
    op: "start",
    sessionId: "lv",
    target: { kind: "window", bundleId, windowId: window.windowId },
    allowlist: [bundleId],
    fps: 60,
    capture: true,
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const settings = { codec: "h264", maxWidth: 3840, maxHeight: 3840, fps: 60, bitrate: 6_000_000 };
  const configured = await send({ version: 2, op: "stream.configure", sessionId: "lv", settings });
  if (!configured.ok) throw new Error(JSON.stringify(configured.error));
  const look = (await act({ op: "state", app: bundleId })).result as {
    nodes: { id: number; role: string; name?: string }[];
  };
  const digits = look.nodes
    .filter((node) => /^[0-9]$/.test(node.name ?? ""))
    .map((node) => node.id);
  await sleep(1500);
  const cpuBefore = cpu(session.pid ?? 0);
  const runStart = performance.now();
  const firstFrame = frames.length;
  const latencies: number[] = [];
  let stillBytes = 0;
  let stills = 0;
  for (let press = 0; press < presses; press++) {
    const id = digits[press % digits.length];
    const sent = performance.now();
    const before = frames.length;
    await act({ op: "act", app: bundleId, actions: [{ type: "click", id }], observe: false });
    // Up to a second for the change, then the still interval (a refine lands here).
    const deadline = sent + 1000;
    while (frames.length === before && performance.now() < deadline) await sleep(1);
    const arrived = frames[before];
    if (arrived) latencies.push(arrived.at - sent);
    await sleep(700);
    for (const frame of frames.slice(before + 1)) {
      if (frame.at - (arrived?.at ?? sent) > 250 && frame.header.keyframe) {
        stills++;
        stillBytes += frame.bytes;
      }
    }
  }
  const seconds = (performance.now() - runStart) / 1000;
  const run = frames.slice(firstFrame);
  const last = run.at(-1)?.header;
  console.log(
    JSON.stringify(
      {
        presses,
        startFrames: frames
          .slice(0, 8)
          .map(
            (f) =>
              `${f.header.codec}${f.header.keyframe ? " key" : ""} ${f.header.width}x${f.header.height} ${Math.round(f.bytes / 1024)} KB`,
          ),
        load: execFileSync("sysctl", ["-n", "vm.loadavg"]).toString().trim(),
        window: `${window.bounds.width}x${window.bounds.height} pt`,
        frame: last ? `${last.width}x${last.height} px ${last.codec} scale ${last.scale}` : "none",
        inputToFrameMs: {
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          samples: latencies.length,
        },
        framesPerSecond: Math.round((run.length / seconds) * 10) / 10,
        wireKbps: Math.round(
          (run.reduce((sum, frame) => sum + frame.bytes, 0) * 8) / seconds / 1000,
        ),
        stillRefines: stills,
        stillRefineKb: stills ? Math.round(stillBytes / stills / 1024) : 0,
        helperCpuPercent: Math.round(((cpu(session.pid ?? 0) - cpuBefore) / seconds) * 1000) / 10,
      },
      null,
      2,
    ),
  );
} finally {
  await send({ version: 2, op: "stop", sessionId: "lv" }).catch(() => undefined);
  session.kill();
  computer.kill();
  server.close();
  rmSync(socketPath, { force: true });
}
