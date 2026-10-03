import { GitService } from "@ace/git";
import { AccountProvider } from "@ace/protocol/accounts";
import { commandContext } from "../commands.ts";
import type { TransitionIO } from "../engine/transitions.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function startThreadTransitions(context: ServiceContext): void {
  const git = new GitService();
  context.resources.own(() => git.close());
  const io: TransitionIO = {
    applyPatch: (request) => git.applyPatch(request),
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
  context.services.transitions = io;
}
export function createThreadTransitionsSession(context: SocketContext): SocketService {
  return {
    command: {
      types: ["thread.fork", "thread.merge", "thread.switch"],
      scope: () => "operate",
      accept(command, device) {
        const p = command.payload;
        if (!("threadId" in p) || !context.canReadThread(p.threadId)) {
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
