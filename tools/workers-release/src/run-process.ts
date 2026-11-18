import { spawn } from "node:child_process";

export interface Ran {
  code: number;
  output: string;
}

/**
 * Runs a command; `capture` keeps its output instead of streaming it to the log. Past
 * `timeoutMs`, the process is killed and the run fails (exit 124), its output saying why.
 */
export type Run = (
  command: string,
  args: readonly string[],
  options: { cwd: string; capture: boolean; timeoutMs?: number },
) => Promise<Ran>;

export const timedOutCode = 124;

/** The real process runner. Wrangler never prompts: CI=1 answers its confirmations. */
export const runProcess: Run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let output = "";
    let timedOut = false;
    const deadline =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (!timedOut) return resolve({ code: code ?? 1, output });
      const why = `${command} timed out after ${options.timeoutMs}ms`;
      if (!options.capture) console.error(why);
      resolve({ code: timedOutCode, output: `${output}${why}\n` });
    });
  });
