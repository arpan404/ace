import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import type { Finding } from "./checks.ts";

const Ready = z.object({
  type: z.literal("ready"),
  url: z.url(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export function readOnlyProfile(
  scratch: string,
  source: string,
  projects: readonly string[] = [],
  checkout = "",
) {
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(scratch)}) (literal "/dev/null"))
(deny file-read* (subpath ${JSON.stringify(source)}))
${projects.map((path) => `(deny file-read-data (require-all (subpath ${JSON.stringify(path)}) (require-not (subpath ${JSON.stringify(checkout)}))))`).join("\n")}
`;
}
export async function startReal(scratch: string, source: string, onFailure: (f: Finding) => void) {
  if (process.platform !== "darwin")
    throw new Error("Real smoke requires macOS sandbox-exec for enforced read-only discovery");
  const home = join(scratch, "home");
  const env: NodeJS.ProcessEnv = {};
  // Preserve the owner's CLI environment, never inherit daemon endpoints or homes.
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("ACE_") && key !== "NODE_OPTIONS" && key !== "ELECTRON_RUN_AS_NODE")
      env[key] = value;
  Object.assign(env, {
    ACE_HOME: home,
    ACE_PORT: "0",
    ACE_LISTEN: "local",
    ACE_LOG_LEVEL: "info",
    ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
    ACE_WORKSPACE_ROOT: join(scratch, "projects"),
    TMPDIR: scratch,
    ACE_CURSOR_SDK_HOME: join(home, "cursor-sdk"),
  });
  const database = new DatabaseSync(join(home, "events.sqlite"), { readOnly: true });
  let projects: string[];
  try {
    projects = z
      .array(z.object({ path: z.string().min(1) }))
      .parse(database.prepare("SELECT path FROM workspaces LIMIT 1024").all())
      .map((row) => row.path);
  } finally {
    database.close();
  }
  const checkout = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
  const script = new URL("./daemon-child.ts", import.meta.url).pathname;
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      readOnlyProfile(await realpath(scratch), await realpath(source), projects, checkout),
      process.execPath,
      script,
    ],
    {
      cwd: scratch,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stopping = false;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384);
    if (/out of memory|heap limit|fatal error|worker.*(?:crash|exited)/i.test(stderr))
      onFailure({ code: "daemon-crash", message: "Daemon or worker reported a fatal failure" });
  });
  child.stdout?.resume();
  child.on("message", (value: unknown) => {
    const failure = z
      .object({
        type: z.literal("shutdown-error"),
        error: z.string(),
        causes: z.array(z.string()).optional(),
      })
      .safeParse(value);
    if (failure.success)
      onFailure({
        code: "daemon-shutdown",
        message: `Daemon failed to close cleanly: ${failure.data.error} ${(failure.data.causes ?? []).join("; ")}`,
      });
  });
  child.on("exit", (code, signal) => {
    if (!stopping)
      onFailure({ code: "daemon-crash", message: `Daemon exited (${code ?? signal})` });
  });
  const ready = new Promise<z.infer<typeof Ready>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Daemon readiness exceeded 90 seconds")),
      90_000,
    );
    const exited = () => {
      clearTimeout(timer);
      reject(new Error("Daemon exited before readiness"));
    };
    child.once("exit", exited);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("message", (value: unknown) => {
      const parsed = Ready.safeParse(value);
      if (!parsed.success) return;
      clearTimeout(timer);
      child.off("exit", exited);
      const url = new URL(parsed.data.url);
      if (url.hostname !== "127.0.0.1" || url.port === "4242" || !url.port)
        reject(new Error("Daemon endpoint is not an isolated loopback port"));
      else resolve(parsed.data);
    });
  });
  const stop = async () => {
    stopping = true;
    await stopGroup(child);
  };
  try {
    return { child, ...(await ready), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
/** Own the whole process group, including metadata CLI children, on every exit path. */
export async function stopGroup(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* already reaped */
    }
  };
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 8000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  kill("SIGKILL");
  await exited;
}
export function rssMiB(pid: number) {
  return (
    z.coerce
      .number()
      .finite()
      .nonnegative()
      .parse(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) /
    1024
  );
}
