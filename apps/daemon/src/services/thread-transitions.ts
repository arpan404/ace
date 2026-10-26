import { GitService } from "@ace/git";
import { AccountProvider } from "@ace/protocol/accounts";
import { accountProvider } from "@ace/accounts";
import { commandContext } from "../commands.ts";
import { ThreadId } from "@ace/protocol";
import type { TransitionIO } from "../engine/transitions.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function startThreadTransitions(context: ServiceContext): void {
  const git = new GitService();
  context.resources.own(() => git.close());
  context.services.transitions = {
    applyPatch: (request) => git.applyPatch(request),
    ...accountTransitions(context),
  };
}
/** Account changes reuse the accounts owner: its registry for usability, its service for copies. */
export function accountTransitions(
  context: Pick<ServiceContext, "now" | "id"> & {
    services: Pick<ServiceContext["services"], "accounts" | "accountRegistry">;
  },
): Pick<TransitionIO, "migrate" | "accountProblem"> {
  return {
    accountProblem(provider, instanceId) {
      const registry = context.services.accountRegistry;
      if (!registry) return undefined;
      if (registry.isPending(instanceId)) return "That account hasn't finished signing in";
      const account = registry.summary(instanceId, context.now());
      // Antigravity's accounts are ACP accounts of its installation (`accountProvider`).
      if (!account || accountProvider(account) !== provider)
        return "That account isn't set up for this provider";
      if (account.availability === "logged_out") return "That account is signed out";
      if (account.availability === "exhausted") return "That account has no usage left";
      return undefined;
    },
    async migrate(request) {
      const provider = AccountProvider.safeParse(request.provider);
      if (!provider.success || !context.services.accounts)
        return { status: "unsupported", reason: "Provider has no accounts migration contract" };
      const response = await context.services.accounts.handle({
        ...request,
        provider: provider.data,
        type: "accounts.migrate",
        requestId: context.id(),
      });
      if (response.type !== "accounts.migrate") throw new Error("Unexpected migration response");
      return response.result;
    },
  };
}
export function createThreadTransitionsSession(context: SocketContext): SocketService {
  return {
    command: {
      types: ["thread.fork", "thread.merge", "thread.switch"],
      scope: () => "operate",
      accept(command, device) {
        const p = command.payload;
        if (
          !("threadId" in p) ||
          !p.threadId ||
          !context.canReadThread(ThreadId.parse(p.threadId))
        ) {
          context.send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error: "thread_not_found",
          });
          return;
        }
        const result = context.options.store.recordCommand(command.id, device, () =>
          context.options.handler.handle(command, commandContext(context.options.store)),
        );
        context.send({ type: "commandResult", ...result });
      },
    },
  };
}
