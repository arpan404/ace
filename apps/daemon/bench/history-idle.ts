import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const entry = process.argv.find((a) => a.startsWith("--entry="))?.slice(8);
if (!entry) throw new Error("Compile the performance entry, then provide --entry=<ace.mjs>");
const root = await mkdtemp(join(tmpdir(), "ace-history-idle-"));
const Reply = z.object({
  id: z.number(),
  memory: z.object({ rss: z.number(), heapUsed: z.number() }),
});
const Failure = z.object({ error: z.string() });
const pending = new Map<number, ReturnType<typeof Promise.withResolvers<z.infer<typeof Reply>>>>();
let child: ReturnType<typeof fork> | undefined;
try {
  await promisify(execFile)(process.execPath, [
    new URL("../../../packages/history-import/bench/generate-scale.ts", import.meta.url).pathname,
    root,
  ]);
  const instances = (["opencode", "codex", "claude"] as const).map((provider) => ({
    id: provider,
    provider,
    homeDir: join(root, provider),
  }));
  const ready = Promise.withResolvers<z.infer<typeof Reply>>();
  pending.set(0, ready);
  child = fork(resolve(entry), [], {
    cwd: root,
    execArgv: ["--heapsnapshot-signal=SIGUSR2"],
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PATH: "",
      ACE_HOME: join(root, "ace"),
      ACE_PORT: "0",
      ACE_LOG_LEVEL: "silent",
      ACE_HISTORY_INSTANCES: JSON.stringify(instances),
      ACE_MODEL_INSTANCES: "[]",
      ACE_RELAY_URL: undefined,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume();
  child.stderr?.on("data", (bytes: Buffer) => process.stderr.write(bytes));
  child.on("message", (value: unknown) => {
    const reply = Reply.safeParse(value).data;
    if (reply) {
      pending.get(reply.id)?.resolve(reply);
      pending.delete(reply.id);
    } else {
      const failure = Failure.safeParse(value).data;
      if (failure) {
        for (const call of pending.values()) call.reject(new Error(failure.error));
        pending.clear();
      }
    }
  });
  child.on("exit", () => {
    for (const call of pending.values()) call.reject(new Error("Scratch daemon exited"));
    pending.clear();
  });
  await ready.promise;
  let seq = 0;
  const request = (op: "history" | "idle-sample" | "cycle") => {
    const call = Promise.withResolvers<z.infer<typeof Reply>>();
    const id = ++seq;
    pending.set(id, call);
    child?.send({ id, op, ...(op === "cycle" ? { count: 1, fresh: true } : {}) });
    return call.promise;
  };
  const scanned = await request("history");
  console.log(JSON.stringify({ phase: "scanned", memory: scanned.memory }));
  for (let index = 0; index < 4; index++) await request("cycle");
  const idleMs = z.coerce
    .number()
    .int()
    .min(3000)
    .max(43200000)
    .parse(process.argv.find((a) => a.startsWith("--idle-ms="))?.slice(10) ?? 600000);
  const start = performance.now();
  let rss = scanned.memory.rss;
  let settledPeakRss = 0;
  do {
    await new Promise<void>((finish) => setTimeout(finish, Math.min(30000, idleMs)));
    const sample = await request("idle-sample");
    rss = sample.memory.rss;
    if (performance.now() - start >= Math.min(120000, idleMs))
      settledPeakRss = Math.max(settledPeakRss, rss);
    console.log(
      JSON.stringify({
        phase: "idle",
        elapsedMs: performance.now() - start,
        memory: sample.memory,
      }),
    );
  } while (performance.now() - start < idleMs);
  if (process.argv.includes("--snapshot")) {
    child.kill("SIGUSR2");
    console.log(JSON.stringify({ phase: "snapshot", directory: root }));
    await new Promise<void>((finish) => setTimeout(finish, 10000));
  }
  if (Math.max(rss, settledPeakRss) > 256 * 1048576)
    throw new Error("Daemon idle RSS exceeds 256 MiB");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((finish) => child?.once("exit", () => finish()));
  }
  if (!process.argv.includes("--snapshot")) await rm(root, { recursive: true, force: true });
}
