import { spawn } from "node:child_process";
import { cliProgram } from "./cli/pty-test-support.ts";

/*
 * The real CLI in a child process: the TypeScript entry, or the Rust binary with
 * ACE_CLI_IMPL=rust (ADR 0221), so one suite describes both implementations.
 */
const program = cliProgram();
export function startCli(home: string, args: string[], stdin = "", env: NodeJS.ProcessEnv = {}) {
  const invocation = openCli(home, args, env);
  invocation.child.stdin.end(stdin);
  return invocation;
}
/** An open stdin lets process tests exercise a real interactive CLI session. */
export function openCli(home: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(program.command, [...program.prefix, ...args], {
    env: { ...process.env, ...program.env, ...env, ACE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, exited };
}
export function invoke(home: string, args: string[], stdin = "", env: NodeJS.ProcessEnv = {}) {
  return startCli(home, args, stdin, env).exited;
}
