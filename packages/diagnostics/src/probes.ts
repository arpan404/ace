import { constants, statSync } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  discoverProviders,
  discoverAntigravity,
  findExecutable,
} from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import { integrityBudgetMs, type DoctorProbes, type Verdict } from "./doctor.ts";
import { checkIntegrity, sqliteSpace } from "./sqlite.ts";
export function portAvailable(port: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  const server = createServer();
  return new Promise((resolve) => {
    const finish = (available: boolean) => {
      signal.removeEventListener("abort", abort);
      server.close();
      resolve(available);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    server.once("error", () => finish(false));
    server.listen(port, "127.0.0.1", () => server.close(() => finish(true)));
  });
}
/**
 * Runs in a child on the daemon's runtime: opens a terminal with `Bun.spawn({ terminal })`,
 * runs a command that prints a marker, and passes only when the marker comes back through the
 * terminal and the command exits cleanly. It decides once both the command has exited and the
 * terminal's output has ended (or 2 s after the exit), since the two arrive separately. Not
 * Bun, no terminal.
 */
const terminalCheck = `
const marker = "ace-terminal-" + "check";
if (typeof Bun !== "object") process.exit(2);
const command = process.platform === "win32"
  ? [process.env.ComSpec ?? "cmd.exe", "/d", "/c", "echo " + marker]
  : ["/bin/sh", "-c", "printf " + marker];
let output = "", ended, code;
const decide = () => {
  if (code === undefined || !ended) return;
  const ok = code === 0 && output.includes(marker);
  process.stdout.write(ok ? "terminal ok\\n" : "terminal failed\\n", () => process.exit(ok ? 0 : 1));
};
const child = Bun.spawn(command, { terminal: { cols: 80, rows: 24,
  data(_terminal, bytes) { output += new TextDecoder().decode(bytes); },
  exit() { setImmediate(() => { ended = true; decide(); }); },
} });
child.exited.then((exitCode) => {
  code = exitCode;
  decide();
  setTimeout(() => { ended = true; decide(); }, 2000);
});
`;
export interface SystemProbeRuntime {
  probe: typeof probeOutput;
  statfs: (directory: string) => Promise<{ bavail: number; bsize: number }>;
}
const systemProbes: SystemProbeRuntime = { probe: probeOutput, statfs };
export function createSystemProbes(
  options: {
    dataDir: string;
    port: number;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Starts the Chromium ace's browser runs (`@ace/browser/engine-check`). */
    browserEngine?: (signal: AbortSignal) => Promise<Verdict>;
  },
  runtime: SystemProbeRuntime = systemProbes,
): DoctorProbes {
  const timeoutMs = options.timeoutMs ?? 4000;
  const databaseBytes =
    fileBytes(join(options.dataDir, "events.sqlite")) +
    fileBytes(join(options.dataDir, "events.sqlite-wal"));
  let discovery: ReturnType<typeof discoverProviders> | undefined;
  let databaseSpace: ReturnType<typeof sqliteSpace> | undefined;
  return {
    node: async () => process.version,
    provider: async (provider, signal) => {
      discovery ??= discoverProviders({
        env: options.env,
        timeoutMs,
        signal,
        probe: runtime.probe,
      });
      return (await discovery)[provider];
    },
    antigravity: (signal) =>
      discoverAntigravity({ env: options.env, timeoutMs, signal, probe: runtime.probe }),
    git: async (signal) => {
      // Finder can launch with no PATH. Prefer an explicit PATH installation,
      // then check the standard system location without invoking a shell.
      const git =
        (await findExecutable("git", options.env)) ??
        (await findExecutable("/usr/bin/git", options.env)) ??
        (await findExecutable("/bin/git", options.env));
      if (!git) return undefined;
      const result = await runtime.probe(git, ["--version"], {
        timeoutMs,
        env: options.env,
        signal,
      });
      return result.code === 0 && /^git version \d[\w.+-]*(?: \([^\r\n]+\))?$/.test(result.stdout)
        ? result.stdout
        : undefined;
    },
    // A real terminal on the daemon's runtime: a short command through Bun's own PTY.
    pty: async (signal) => {
      const result = await runtime.probe(process.execPath, ["-e", terminalCheck], {
        timeoutMs,
        env: options.env,
        signal,
      });
      return result.code === 0 && result.stdout.includes("terminal ok");
    },
    chromium: async (signal) =>
      options.browserEngine
        ? options.browserEngine(signal)
        : {
            status: "warn",
            message: "ace's browser engine was not checked",
            fix: "Run ace doctor from the ace installation to check ace's browser.",
          },
    disk: async () => {
      let directory = options.dataDir;
      for (;;) {
        try {
          const fs = await runtime.statfs(directory);
          let writable = true;
          try {
            await access(
              directory,
              constants.W_OK |
                constants.X_OK |
                (directory === options.dataDir ? constants.R_OK : 0),
            );
          } catch {
            writable = false;
          }
          return { writable, freeBytes: fs.bavail * fs.bsize };
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          const parent = dirname(directory);
          if (parent === directory) throw new Error("Cannot inspect disk", { cause: error });
          directory = parent;
        }
      }
    },
    // The child process gets the same size-scaled budget as the check itself.
    integrity: (signal) =>
      checkIntegrity(join(options.dataDir, "events.sqlite"), signal, {
        probe: probeOutput,
        deadlineMs: integrityBudgetMs(databaseBytes),
      }),
    databaseBytes,
    databaseSpace: (signal) =>
      (databaseSpace ??= sqliteSpace(join(options.dataDir, "events.sqlite"), signal)),
    port: (signal) => portAvailable(options.port, signal),
  };
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
