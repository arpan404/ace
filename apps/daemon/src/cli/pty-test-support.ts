import { spawnNativePty } from "@ace/terminal";
import { fileURLToPath } from "node:url";

/*
 * The real CLI in a pseudo-terminal, as a person at a terminal runs it: for process tests of
 * what only happens with a terminal on the other end (prompts, typed confirmations, the home).
 */
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** The CLI program a process test runs: the TypeScript entry, or the Rust binary (ADR 0221). */
export interface CliProgram {
  command: string;
  /** Arguments in front of the CLI's own. */
  prefix: string[];
  /** Extra environment the Rust binary needs to hand a command to the TypeScript bundle. */
  env: Record<string, string>;
}

/**
 * `ACE_CLI_IMPL=rust` runs the same test file against `native/cli`'s binary, so one suite
 * describes both implementations. `ACE_CLI_BIN` picks a build other than the release one.
 */
export function cliProgram(): CliProgram {
  if (process.env.ACE_CLI_IMPL !== "rust")
    return { command: process.execPath, prefix: [cli], env: {} };
  return {
    command:
      process.env.ACE_CLI_BIN ??
      fileURLToPath(new URL("../../../../native/cli/target/release/ace", import.meta.url)),
    prefix: [],
    // Hand-over finds the runtime and the bundle through the development override.
    env: { ACE_CLI_NODE: process.execPath, ACE_CLI_ENTRY: cli },
  };
}

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
  const program = cliProgram();
  const pty = spawnNativePty(program.command, [...program.prefix, ...args], {
    cwd: empty,
    cols: 100,
    rows: 30,
    env: { ...environment(home, empty), ...program.env },
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
  const waitFor = async (text: string, ms = 10_000, from = 0) => {
    const deadline = Date.now() + ms;
    while (!output.slice(from).includes(text)) {
      if (Date.now() > deadline)
        throw new Error(
          `Never saw ${JSON.stringify(text)} in ${JSON.stringify(output.slice(-2000))}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { pty, exited, waitFor, output: () => output };
}
