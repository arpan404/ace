import { spawn } from "node:child_process";
import { z } from "zod";

// A pipe watchdog gives the encoder a lifetime even if the daemon is SIGKILLed.
// This file is a standalone Node entry point, never imported by the service.
const options = z
  .object({
    executable: z.string().min(1).max(8192),
    cwd: z.string().min(1).max(8192),
    args: z.array(z.string().max(8192)).max(64),
  })
  .parse(JSON.parse(process.argv[2] ?? "null"));
const encoder = spawn(options.executable, options.args, { cwd: options.cwd, stdio: "ignore" });
const stop = () => {
  encoder.kill("SIGKILL");
};
process.stdin.resume();
process.stdin.once("end", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
encoder.once("error", () => {
  process.exitCode = 1;
  process.stdin.destroy();
});
encoder.once("close", (code) => {
  process.exitCode = code ?? 1;
  process.stdin.destroy();
});
