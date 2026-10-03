import { agentControlToolkit } from "@ace/mcp-server";
import { screenToolkit } from "@ace/screen";
import { startDaemonMcp } from "../mcp.ts";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;

  const mcp = await startDaemonMcp(
    store,
    [
      agentControlToolkit({
        async execute(caller, operation, signal) {
          return services.agentControl
            ? services.agentControl.port.execute(caller, operation, signal)
            : { ok: false, code: "unsupported" };
        },
      }),
      ...(options.toolkits ?? []),
      ...(services.screen ? [screenToolkit(services.screen)] : []),
    ],
    async (intent, signal) => {
      signal.throwIfAborted();
      const parent = store.getThread(intent.threadId);
      if (!services.agentControl || !parent) throw new Error("Delegation unavailable");
      const record = services.agentControl.delegations.delegate(intent, {
        requestId: context.id(),
        provider: intent.input.provider ?? parent.provider,
        role: intent.input.name ?? "delegate",
        task: intent.input.task,
        wait: false,
        estimatedLoad: 0,
      });
      return { intentId: record.childId };
    },
  );
  resources.own(() => mcp.close());
  services.mcp = mcp;
}
