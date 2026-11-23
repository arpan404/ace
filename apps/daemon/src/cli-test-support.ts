import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
// The Rust binary under test, mirroring the switch in cli/pty-test-support.ts.
const rust = process.env.ACE_CLI_IMPL === "rust";
const rustBin =
  process.env.ACE_CLI_BIN ??
  fileURLToPath(new URL("../../../native/cli/target/debug/ace", import.meta.url));
export function startCli(home: string, args: string[], stdin = "", env: NodeJS.ProcessEnv = {}) {
  const invocation = openCli(home, args, env);
  invocation.child.stdin.end(stdin);
  return invocation;
}
/** An open stdin lets process tests exercise a real interactive CLI session. */
export function openCli(home: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  // Under ACE_CLI_IMPL=rust the bundle is reached through the development override, so a
  // handed-over command runs the same TypeScript entry as without the switch.
  const child = rust
    ? spawn(rustBin, args, {
        env: {
          ...process.env,
          ...env,
          ACE_HOME: home,
          ACE_CLI_NODE: process.execPath,
          ACE_CLI_ENTRY: cli,
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, ...env, ACE_HOME: home },
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
