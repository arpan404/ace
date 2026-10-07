import { createCursorAccountDriver } from "@ace/adapter-cursor/auth";
import { runCursorAccountFlow } from "./cursor-account-flow.ts";

// A PTY-owned helper. The SDK host discards keys; only its browser URL reaches this terminal.
process.exitCode = await runCursorAccountFlow(process.argv.slice(2), {
  driver: createCursorAccountDriver({
    launchEnv: process.env,
    // The daemon has fenced and drained this instance before launching this helper.
    stopInstance: async () => {},
  }),
  signal: new AbortController().signal,
  output: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
});
