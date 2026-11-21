import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { webBuild } from "./editor-daemon.ts";
import { startPreview } from "./preview-server.ts";

/*
 * The editor flow test's machine: a temporary checkout, a real daemon on it in a temporary home
 * (editor-flow-daemon.ts, with a scripted Claude Code that links a file in its reply), and the
 * production web build served beside it. The daemon's environment is written out here in full,
 * so nothing of the person's (their ~/.ace, their CLIs, their PATH) reaches it.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;
const script = new URL("./editor-flow-daemon.ts", import.meta.url).pathname;

const filesBuilds = ["release", "debug"].map(
  (profile) =>
    new URL(`../../../native/files/target/${profile}/ace-files`, import.meta.url).pathname,
);

const Started = z.object({ url: z.string(), token: z.string(), threadId: z.string() });

export interface EditorFlowMachine {
  origin: string;
  daemon: { url: string; token: string };
  threadId: string;
  /** The checkout's real path, for writing to it as an agent would. */
  checkout: string;
}

export async function withEditorFlow<T>(
  options: { files: Record<string, string>; reply: string },
  run: (machine: EditorFlowMachine) => Promise<T>,
): Promise<T> {
  // Without it every read answers FILES_RESTARTING and the editor can only say it couldn't read.
  if (process.platform !== "win32" && !filesBuilds.some((path) => existsSync(path)))
    throw new Error("Build ace-files first: cargo build --release in native/files");
  const scratch = await realpath(mkdtempSync(join(tmpdir(), "ace-editor-flow-")));
  const home = join(scratch, "home");
  const checkout = join(scratch, "checkout");
  await mkdir(join(home, "tmp"), { recursive: true });
  try {
    for (const [path, text] of Object.entries(options.files)) {
      await mkdir(join(checkout, path, ".."), { recursive: true });
      await writeFile(join(checkout, path), text);
    }
    // A project is a git checkout, as a real one is: the thread reads its files through it.
    const git = (...args: string[]) =>
      promisify(execFile)(
        "git",
        ["-c", "user.name=ace", "-c", "user.email=editor-flow@ace.invalid", ...args],
        { cwd: checkout, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } },
      );
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-q", "-m", "Start");
    const preview = await startPreview(web, await webBuild());
    try {
      const daemon = await startFlowDaemon(home, checkout, preview.origin, options.reply);
      try {
        return await run({
          origin: preview.origin,
          daemon: { url: daemon.started.url, token: daemon.started.token },
          threadId: daemon.started.threadId,
          checkout,
        });
      } finally {
        await daemon.stop();
      }
    } finally {
      await preview.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function startFlowDaemon(home: string, checkout: string, origin: string, reply: string) {
  const child = spawn(bunBinary(), [script, home, checkout, origin, reply], {
    cwd: checkout,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local/state"),
      TMPDIR: join(home, "tmp"),
      ACE_HOME: home,
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_WORKSPACE_ROOT: join(checkout, ".."),
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_LISTEN: "local",
      ACE_LOG_LEVEL: "warn",
      // git, and no provider CLI: none lives in the system folders.
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    // Its stdin is a pipe only this process holds: the daemon stops when it closes.
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-16_000)));
  const started = await new Promise<z.infer<typeof Started>>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((each) => each.trim().startsWith("{"));
      if (line) resolve(Started.parse(JSON.parse(line)));
    });
    child.once("exit", (code) =>
      reject(new Error(`editor flow daemon exited (${code}): ${stderr}`)),
    );
    child.once("error", reject);
  });
  return {
    started,
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
