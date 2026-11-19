import { z } from "zod";
import { AccountSummary, ProviderInstance } from "@ace/protocol/accounts";
import type { Args } from "./args.ts";
import { emit } from "./io.ts";
import { CliFailure } from "./output.ts";
import {
  discoveredLines,
  providerAccountLines,
  providerAccountShowLines,
} from "./render/account.ts";

/**
 * `ace provider account …`: the provider-account registry (`@ace/accounts`), which writes
 * `accounts.sqlite` itself and needs no daemon. Its JSON lines are read back here, so each
 * command prints its own words, or one JSON value with --json.
 */
const Account = AccountSummary.loose();
const Accounts = z.array(Account);
const Found = z.array(ProviderInstance.loose());

export type AccountVerb = "list" | "add" | "show" | "discover";

const registryVerbs: Readonly<Record<AccountVerb, string>> = {
  list: "list",
  add: "add",
  show: "status",
  discover: "discover",
};

/** The registry's output lines as values; each line it writes is one JSON value. */
export function registryValues(text: string): unknown[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
}

export async function providerAccountCommand(args: Args, verb: AccountVerb): Promise<void> {
  const { runAccountsCommand } = await import("@ace/accounts");
  const machine = args.flags.json === true || args.flags.jq !== undefined;
  let text = "";
  try {
    await runAccountsCommand(
      [
        "accounts",
        registryVerbs[verb],
        ...args.words,
        ...(args.flags.console ? ["--console"] : []),
      ],
      {
        write: (value) => {
          text += value;
        },
        // A sign-in's address is progress: never on stdout when the result is JSON.
        progress: (value) => (machine ? process.stderr : process.stdout).write(value),
        loginOutput: machine ? "stderr" : "stdout",
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Unknown instance")
      throw new CliFailure("refused", `No provider account ${args.words[0]}.`, undefined, {
        code: "not_found",
        hint: "See them with ace provider account list.",
      });
    throw error;
  }
  const values = registryValues(text);
  // The registry is ace's own; a shape it grew that this build doesn't know prints as data.
  const shaped = <T>(schema: z.ZodType<T>, value: unknown, human: (parsed: T) => string[]) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? emit(args, parsed.data, { human }) : emit(args, value);
  };
  if (verb === "list") return shaped(Accounts, values[0] ?? [], providerAccountLines);
  if (verb === "show") return shaped(Account, values[0], providerAccountShowLines);
  if (verb === "discover") return shaped(Found, values, discoveredLines);
  const added = values.at(-1);
  const ok = added !== null && typeof added === "object" && Reflect.get(added, "ok") === true;
  return emit(args, added, {
    human: () =>
      ok
        ? `Added ${args.words[1] ?? "the account"}.`
        : `The account was added, but its sign-in didn't finish. Check it with ace provider account show ${args.words[1] ?? "ID"}.`,
    quiet: () => [],
  });
}
