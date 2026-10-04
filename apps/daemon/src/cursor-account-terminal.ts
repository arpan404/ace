import { createCursorAccountDriver } from "@ace/adapter-cursor";
import { z } from "zod";

// A PTY-owned helper. The SDK host discards keys; only its browser URL reaches this terminal.
try {
  const [id, homeDir, action] = z
    .tuple([z.string().min(1), z.string().min(1), z.enum(["login", "logout"])])
    .parse(process.argv.slice(2));
  const driver = createCursorAccountDriver({
    launchEnv: process.env,
    // The daemon has fenced and drained this instance before launching this helper.
    stopInstance: async () => {},
  });
  const signal = new AbortController().signal;
  const instance = { id, homeDir };
  if (action === "login")
    await driver.login(instance, signal, (url) => process.stdout.write(`${url}\r\n`));
  else await driver.logout(instance, signal);
  process.stdout.write("Cursor SDK authentication flow completed.\r\n");
} catch {
  process.stderr.write("Cursor SDK authentication flow failed.\r\n");
  process.exitCode = 1;
}
