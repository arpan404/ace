import { Writable } from "node:stream";
import { MachineAccountStatus } from "@ace/protocol";
import { accessRequest } from "../client-access.ts";
import { hostConnection } from "./connection.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";

const pollMs = 2_000;
const machine = (args: Args) => args.flags.json === true || args.flags.jq !== undefined;
const signedInText = (status: MachineAccountStatus) =>
  status.account ? `Signed in to ace as ${status.account.email}.` : "Signed in to ace.";

/** A machine code from stdin, or typed at a terminal without echo. Never from argv history. */
async function readCode(args: Args): Promise<string> {
  const supplied = args.words[2];
  if (supplied !== undefined && supplied !== "-") return supplied;
  if (!process.stdin.isTTY) {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 4096) throw new CliFailure("refused", "Machine code is too long");
    }
    return text.split(/\r?\n/)[0] ?? "";
  }
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

/**
 * `ace login` / `ace logout` sign this machine's daemon in to an ace account (ADR 0111);
 * `ace machine-code set|clear` sets the code account devices enter once.
 */
export async function aceAccountCommand(args: Args, home: string): Promise<void> {
  const { origin, token } = hostConnection(home);
  const call = async (path: string, method: string, body?: unknown) =>
    MachineAccountStatus.parse(
      await accessRequest(origin, path, { method, token, ...(body ? { body } : {}) }),
    );
  const command = args.words[0];
  if (command === "logout") {
    validateArgs(args, [], 1);
    const status = await call("/v1/ace-account", "DELETE");
    return result(args, machine(args) ? status : "Signed out of ace on this machine.");
  }
  if (command === "machine-code") {
    const verb = args.words[1];
    if (verb === "clear") {
      validateArgs(args, [], 2);
      const status = await call("/v1/machine-code", "DELETE");
      return result(args, machine(args) ? status : "Machine code cleared.");
    }
    if (verb !== "set") throw new CliFailure("refused", "Use ace machine-code set|clear.");
    validateArgs(args, [], 2, 3);
    const status = await call("/v1/machine-code", "PUT", { code: await readCode(args) });
    return result(
      args,
      machine(args) ? status : "Machine code set. Devices on your account enter it once.",
    );
  }
  validateArgs(args, ["origin"], 1);
  const accountOrigin = option(args, "origin");
  let status = await call(
    "/v1/ace-account/login",
    "POST",
    accountOrigin ? { origin: accountOrigin } : {},
  );
  const login = status.login;
  if (!login) throw new CliFailure("uncertain", "ace sign-in did not start. Try again.");
  // The URL is progress, not the result: on stderr when the result is JSON.
  (machine(args) ? process.stderr : process.stdout).write(
    `Open this address to sign in to ace:\n${login.url}\n`,
  );
  while (!status.signedIn || status.login) {
    if (!status.login || Date.now() >= login.expiresAt)
      throw new CliFailure("timeout", "ace sign-in expired. Run ace login again.");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = await call("/v1/ace-account", "GET");
  }
  return result(args, machine(args) ? status : signedInText(status));
}
