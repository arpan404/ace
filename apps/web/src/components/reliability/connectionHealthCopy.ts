import type { ServerProvider } from "@ace/contracts";
import type { ConnectionHealthSnapshot } from "~/lib/reliability/connectionHealth";
import type { Thread } from "~/types";

export interface ReliabilityDiagnosticsInput {
  readonly connection: ConnectionHealthSnapshot;
  readonly provider: ServerProvider | null;
  readonly thread: Thread | null;
}

export function buildReliabilityDiagnosticsCopy(input: ReliabilityDiagnosticsInput): string {
  return JSON.stringify(
    {
      connection: {
        kind: input.connection.kind,
        lastError: input.connection.lastError,
        reconnectCount: input.connection.reconnectCount,
      },
      provider: input.provider
        ? {
            provider: input.provider.provider,
            providerInstanceId: input.provider.providerInstanceId ?? null,
            status: input.provider.status,
            authStatus: input.provider.auth.status,
            message: input.provider.message ?? null,
          }
        : null,
      thread: input.thread
        ? {
            threadId: input.thread.id,
            sessionStatus: input.thread.session?.status ?? null,
            latestTurnState: input.thread.latestTurn?.state ?? null,
            lastError: input.thread.error ?? input.thread.session?.lastError ?? null,
          }
        : null,
    },
    null,
    2,
  );
}
