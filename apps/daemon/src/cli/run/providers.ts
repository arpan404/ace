import type { Client } from "@ace/client";
import { accessHandlers } from "./access.ts";
import { withSession, type CommandContext, type Handlers } from "./context.ts";

/** Providers, models and the ace account (ADR 0176 §7); access commands join from access.ts. */

type Providers = typeof import("../providers.ts");
function providers(
  context: CommandContext,
  pick: (
    module: Providers,
  ) => (args: CommandContext["args"], client: Client, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) =>
    pick(await import("../providers.ts"))(context.args, client, signal),
  );
}

async function accounts(context: CommandContext, verb: "list" | "add" | "show" | "discover") {
  return (await import("../provider-accounts.ts")).providerAccountCommand(context.args, verb);
}

async function aceAccount(
  context: CommandContext,
  verb: import("../ace-account.ts").AceAccountVerb,
): Promise<void> {
  return (await import("../ace-account.ts")).aceAccountCommand(
    context.args,
    (await context.config()).dataDir,
    verb,
  );
}

export const providerHandlers: Handlers = {
  "provider.list": (context) => providers(context, (module) => module.providerList),
  "provider.show": (context) => providers(context, (module) => module.providerShow),
  "provider.capabilities": (context) => providers(context, (module) => module.capabilities),
  "provider.login": (context) =>
    providers(
      context,
      (module) => (args, client, signal) => module.providerLogin(args, client, signal),
    ),
  "model.list": (context) => providers(context, (module) => module.modelList),
  "provider.account.list": (context) => accounts(context, "list"),
  "provider.account.add": (context) => accounts(context, "add"),
  "provider.account.show": (context) => accounts(context, "show"),
  "provider.account.discover": (context) => accounts(context, "discover"),
  "account.status": (context) => aceAccount(context, "status"),
  "account.login": (context) => aceAccount(context, "login"),
  "account.logout": (context) => aceAccount(context, "logout"),
  "account.machine-code.set": (context) => aceAccount(context, "code-set"),
  "account.machine-code.clear": (context) => aceAccount(context, "code-clear"),
  ...accessHandlers,
};
