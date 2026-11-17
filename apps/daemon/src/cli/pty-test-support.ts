import { spawnNativePty } from "@ace/terminal";
import { fileURLToPath } from "node:url";

/*
 * The real CLI in a pseudo-terminal, as a person at a terminal runs it: for process tests of
 * what only happens with a terminal on the other end (prompts, typed confirmations, the home).
 */
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** The person's terminal: the CLI's environment with nothing from this machine's own ace. */
export function environment(home: string, empty: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    ACE_HOME: home,
    HOME: empty,
    TERM: "xterm-256color",
    NO_COLOR: "1",
    ACE_LOG_LEVEL: "silent",
  };
}

export function openPty(home: string, empty: string, args: string[] = []) {
  const pty = spawnNativePty(process.execPath, [cli, ...args], {
    cwd: empty,
    cols: 100,
    rows: 30,
    env: environment(home, empty),
  });
  let output = "";
  const exited = new Promise<number | null>((resolve) => {
    pty.onExit((input) => {
      const code =
        typeof input === "object" && input !== null ? Reflect.get(input, "exitCode") : undefined;
      resolve(typeof code === "number" ? code : null);
    });
  });
  pty.onData((input) => {
    output +=
      typeof input === "string"
        ? input
        : input instanceof Uint8Array
          ? Buffer.from(input).toString("utf8")
          : "";
  });
  const waitFor = async (text: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!output.includes(text)) {
      if (Date.now() > deadline)
        throw new Error(
          `Never saw ${JSON.stringify(text)} in ${JSON.stringify(output.slice(-2000))}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { pty, exited, waitFor, output: () => output };
}
