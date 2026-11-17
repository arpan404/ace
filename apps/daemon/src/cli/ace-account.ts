import { Writable } from "node:stream";
import { MachineAccountStatus } from "@ace/protocol";
import { accessRequest } from "../client-access.ts";
import { reachLocalDaemon } from "./connection.ts";
import { option, type Args } from "./args.ts";
import { emit } from "./io.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { aceAccountLines } from "./render/account.ts";

const pollMs = 2_000;
const machine = (args: Args) => args.flags.json === true || args.flags.jq !== undefined;
const show = (args: Args, status: MachineAccountStatus, human?: string) =>
  emit(args, status, {
    human: human === undefined ? aceAccountLines : () => human,
    quiet: () => [],
  });

/**
 * The machine code: the argument, stdin only for `-`, or typed at a terminal without echo.
 * Never read from stdin unasked, so an agent's open pipe is never waited on (ADR 0176 §9).
 */
async function readCode(args: Args): Promise<string> {
  const supplied = args.words[0];
  if (supplied !== undefined && supplied !== "-") return supplied;
  if (supplied === "-") {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 4096) throw usageFailure("The machine code on stdin is too long.");
    }
    const code = text.split(/\r?\n/)[0]?.trim() ?? "";
    if (!code)
      throw usageFailure("The machine code on stdin is empty.", { code: "missing_argument" });
    return code;
  }
  if (!args.interactive || !process.stdin.isTTY)
    throw usageFailure("ace account machine-code set needs the code.", {
      code: "missing_argument",
      argument: "CODE",
      hint: "Pass it as CODE, or - to read it from stdin.",
    });
  const { createInterface } = await import("node:readline/promises");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = reader.question("Machine code: ");
    muted = true;
    return await answer;
  } finally {
    reader.close();
    process.stderr.write("\n");
  }
}

export type AceAccountVerb = "status" | "login" | "logout" | "code-set" | "code-clear";

/**
 * `ace account …` (and the `ace login` / `ace logout` shortcuts) sign this machine's daemon in
 * to an ace account (ADR 0111) and set the code account devices enter once.
 */
export async function aceAccountCommand(
  args: Args,
  home: string,
  verb: AceAccountVerb,
): Promise<void> {
  const { origin, token } = await reachLocalDaemon(home);
  const call = async (path: string, method: string, body?: unknown) =>
    MachineAccountStatus.parse(
      await accessRequest(origin, path, { method, token, ...(body ? { body } : {}) }),
    );
  if (verb === "status") return show(args, await call("/v1/ace-account", "GET"));
  if (verb === "logout")
    return show(
      args,
      await call("/v1/ace-account", "DELETE"),
      "Signed out of ace on this machine.",
    );
  if (verb === "code-clear")
    return show(args, await call("/v1/machine-code", "DELETE"), "Machine code cleared.");
  if (verb === "code-set") {
    const status = await call("/v1/machine-code", "PUT", { code: await readCode(args) });
    return show(args, status, "Machine code set. Devices on your account enter it once.");
  }
  const accountOrigin = option(args, "origin");
  let status = await call(
    "/v1/ace-account/login",
    "POST",
    accountOrigin ? { origin: accountOrigin } : {},
  );
  const login = status.login;
  if (!login)
    throw new CliFailure("uncertain", "ace sign-in didn't start.", undefined, {
      hint: "Run ace login again.",
    });
  // The address is progress, not the result: on stderr when the result is JSON.
  (machine(args) ? process.stderr : process.stdout).write(
    `Open this address to sign in to ace:\n${login.url}\n`,
  );
  while (!status.signedIn || status.login) {
    if (!status.login || Date.now() >= login.expiresAt)
      throw new CliFailure("timeout", "ace sign-in expired.", undefined, {
        hint: "Run ace login again.",
      });
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = await call("/v1/ace-account", "GET");
  }
  return show(args, status);
}
