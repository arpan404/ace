import { Command, type ContentPart, type ContextDiagnostic, type ThreadId } from "@ace/protocol";
import type { ContextService } from "./service.ts";
import type { Projection, ProjectionCapabilities } from "./projection.ts";
import { requireContext } from "./errors.ts";

export interface ContextDelivery {
  threadId: ThreadId;
  input: ContentPart[];
  delivery: "steer" | "queue";
  context: Projection;
}
/** Resolves only after the provider has consumed local files, or stopped consuming on failure. */
export type ContextConsumer = (message: ContextDelivery) => Promise<void>;

/** Engine boundary: preserve native provider blocks and own their lifetime through consumption. */
export async function deliverContext(
  service: ContextService,
  value: unknown,
  capabilities: ProjectionCapabilities,
  consume: ContextConsumer,
): Promise<ContextDiagnostic[]> {
  const command = Command.parse(value);
  const payload = command.payload;
  requireContext(payload.type === "thread.send", "invalid_request", "Expected thread.send");
  const prepared = await service.compose(
    command.deviceId,
    payload.threadId,
    payload.context ?? { mentions: [], attachments: [] },
    capabilities,
  );
  try {
    await consume({
      threadId: payload.threadId,
      input: payload.input,
      delivery: payload.delivery,
      context: prepared.projection,
    });
    return prepared.diagnostics;
  } finally {
    prepared.release();
  }
}
