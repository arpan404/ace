import { emit, print } from "../io.ts";
import {
  legacy,
  prepareHome,
  withSession,
  without,
  type CommandContext,
  type Handlers,
} from "./context.ts";

async function providers(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../providers.ts")).providersCommand(args, client, signal),
  );
}

/** The provider-account registry writes `accounts.sqlite` itself, with its own text. */
async function accounts(context: CommandContext, verb: string): Promise<void> {
  const { runAccountsCommand } = await import("@ace/accounts");
  const machine = context.mode === "json";
  const lines: string[] = [];
  await runAccountsCommand(
    ["accounts", verb, ...context.args.words, ...(context.args.flags.console ? ["--console"] : [])],
    {
      write: (value) => lines.push(value),
      progress: (value) => (machine ? process.stderr : process.stdout).write(value),
      loginOutput: machine ? "stderr" : "stdout",
    },
  );
  const output = lines.flatMap((line) => line.trim().split("\n")).filter(Boolean);
  if (!machine) return emit(context.args, lines.join("").trimEnd());
  const values = output.map((line): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return { message: line };
    }
  });
  await print(context.args, values.length === 1 ? values[0] : values);
}

async function aceAccount(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return (await import("../ace-account.ts")).aceAccountCommand(args, context.config().dataDir);
}

async function access(context: CommandContext, words: string[]): Promise<void> {
  const args = legacy(context, words);
  return (await import("../access.ts")).accessCommand(args, context.config().dataDir);
}

async function remote(context: CommandContext, verb: string): Promise<void> {
  const { dataDir } = context.config();
  await prepareHome(dataDir);
  const module = await import("../remote.ts");
  const { flags, words } = context.args;
  if (verb === "add" && typeof flags.link === "string") {
    const name = words[0] ?? flags.profile;
    const args = {
      ...context.args,
      words: ["pair", "redeem", flags.link],
      flags: {
        ...without(flags, "link", "profile"),
        ...(typeof name === "string" ? { profile: name } : {}),
      },
    };
    return module.redeemCommand(args, dataDir);
  }
  return module.remoteCommand(legacy(context, ["remote", verb]), dataDir);
}

async function mcp(context: CommandContext, verb: string): Promise<void> {
  const args = legacy(context, ["mcp", verb]);
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../control.ts")).controlCommand(args, client, signal),
  );
}

export const providerHandlers: Handlers = {
  "provider.list": (context) => providers(context, ["providers", "status"]),
  "provider.capabilities": (context) => providers(context, ["capabilities"]),
  "provider.login": async (context) => {
    const { flags } = context.args;
    const account = flags.account ?? flags.instance;
    const args = {
      ...legacy(context, ["login"]),
      flags: {
        ...without(flags, "account", "instance"),
        ...(typeof account === "string" ? { instance: account } : {}),
      },
    };
    return withSession(context, args, async ({ client, signal }) =>
      (await import("../providers.ts")).loginCommand(args, client, signal),
    );
  },
  "provider.account.list": (context) => accounts(context, "list"),
  "provider.account.add": (context) => accounts(context, "add"),
  "provider.account.show": (context) => accounts(context, "status"),
  "provider.account.discover": (context) => accounts(context, "discover"),
  "account.login": (context) => aceAccount(context, ["login"]),
  "account.logout": (context) => aceAccount(context, ["logout"]),
  "account.machine-code.set": (context) => aceAccount(context, ["machine-code", "set"]),
  "account.machine-code.clear": (context) => aceAccount(context, ["machine-code", "clear"]),
  "device.list": (context) => access(context, ["devices", "list"]),
  "device.pair": (context) => access(context, ["pair"]),
  "device.revoke": (context) => access(context, ["devices", "revoke"]),
  "remote.list": (context) => remote(context, "list"),
  "remote.add": (context) => remote(context, "add"),
  "remote.use": (context) => remote(context, "use"),
  "remote.remove": (context) => remote(context, "remove"),
  "mcp.list": (context) => mcp(context, "list"),
  "mcp.add": (context) => mcp(context, "enroll"),
  "mcp.revoke": (context) => mcp(context, "revoke"),
};
