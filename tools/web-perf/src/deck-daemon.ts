import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { bunBinary } from "../../../scripts/runtimes.ts";
import { startPreview } from "./preview-server.ts";

/*
 * The Deck budget run's machine (docs/editor/workbench.md 59): a real daemon (`ace start`) in a
 * temporary home, with nothing of the person's environment, whose one project is a temporary
 * checkout of generated files, and the production web build served beside it. `ACE_DEV=1` gives
 * the daemon its development thread in the checkout and the stub handler, so no provider CLI
 * runs and no prompt is sent. The page reaches the daemon as a browser tab pointed at it does:
 * its address and token in the connection settings' storage, its origin allowed by the daemon.
 */

const web = new URL("../../../apps/web/", import.meta.url).pathname;
const cli = new URL("../../../apps/daemon/src/cli.ts", import.meta.url).pathname;

/** One production build per process, removed when the process exits. */
let build: Promise<string> | undefined;
export function webBuild(): Promise<string> {
  const prebuilt = process.env.ACE_DECK_PERF_BUILD;
  if (prebuilt) return Promise.resolve(prebuilt);
  build ??= (async () => {
    const out = mkdtempSync(join(tmpdir(), "ace-deck-perf-web-"));
    process.once("exit", () => rmSync(out, { recursive: true, force: true }));
    await promisify(execFile)("bunx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
      cwd: web,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out;
  })();
  return build;
}

const Started = z.object({ url: z.string(), tokenPath: z.string() });

export interface DeckMachine {
  /** The web app's origin. */
  origin: string;
  /** The daemon's local WebSocket address and its token, for the page's storage. */
  daemon: { url: string; token: string };
  /** The checkout the daemon's development thread works in. */
  checkout: string;
  /** The development thread, whose Deck the run fills. */
  threadId: string;
}

/** `files` (checkout-relative path → text) in a fresh checkout, a daemon on it, and the app. */
export async function withDeckMachine<T>(
  files: Iterable<[string, string]>,
  run: (machine: DeckMachine) => Promise<T>,
): Promise<T> {
  const scratch = await realpath(mkdtempSync(join(tmpdir(), "ace-deck-perf-")));
  const home = join(scratch, "home");
  const checkout = join(scratch, "checkout");
  await mkdir(home, { recursive: true });
  await mkdir(checkout, { recursive: true });
  try {
    for (const [path, text] of files) {
      await mkdir(join(checkout, path, ".."), { recursive: true });
      await writeFile(join(checkout, path), text);
    }
    const preview = await startPreview(web, await webBuild());
    try {
      const daemon = await startDaemon(home, checkout, preview.origin);
      try {
        const threadId = await developmentThread(daemon.target);
        return await run({ origin: preview.origin, daemon: daemon.target, checkout, threadId });
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

async function startDaemon(home: string, checkout: string, origin: string) {
  const child = spawn(bunBinary(), [cli, "start", "--json"], {
    cwd: checkout,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      ACE_HOME: join(home, "daemon"),
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_WORKSPACE_ROOT: join(checkout, ".."),
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_PORT: "0",
      ACE_LISTEN: "local",
      ACE_LOG_LEVEL: "warn",
      ACE_MAINTENANCE: "0",
      ACE_DEV: "1",
      ACE_WEB_ORIGINS: origin,
      // No provider CLI can be found.
      PATH: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
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
    child.once("exit", (code) => reject(new Error(`ace start exited (${code}): ${stderr}`)));
    child.once("error", reject);
  });
  const token = (await readFile(started.tokenPath, "utf8")).trim();
  return {
    target: { url: started.url, token },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

const ThreadsSnapshot = z.object({
  type: z.literal("snapshot"),
  view: z.object({ kind: z.literal("threads"), threads: z.record(z.string(), z.unknown()) }),
});

/** The id of the daemon's one thread, from a threads subscription's snapshot. */
async function developmentThread(target: { url: string; token: string }): Promise<string> {
  const socket = new WebSocket(target.url);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const snapshot = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No threads snapshot")), 30_000);
      socket.addEventListener("message", (event) => {
        const parsed = ThreadsSnapshot.safeParse(JSON.parse(String(event.data)));
        const id = parsed.success ? Object.keys(parsed.data.view.threads)[0] : undefined;
        if (!id) return;
        clearTimeout(timer);
        resolve(id);
      });
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        deviceId: "deck-perf",
        token: target.token,
      }),
    );
    socket.send(
      JSON.stringify({ type: "subscribe", subscriptionId: "threads", scope: { kind: "threads" } }),
    );
    return await snapshot;
  } finally {
    socket.close();
  }
}
