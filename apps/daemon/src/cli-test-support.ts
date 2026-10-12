import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
export function startCli(home: string, args: string[], stdin = "", env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
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
  child.stdin.end(stdin);
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
