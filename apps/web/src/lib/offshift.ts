import type { ClientApi } from "@ace/client";
import type { ThreadId } from "@ace/protocol";
import type { OffshiftPersonOperation, OffshiftClientResult } from "@ace/protocol/offshift-person";
import type { OffshiftView } from "@ace/protocol/offshift";

/*
 * The person's own Offshift controls over `offshift.request`: start a run, mark steps done,
 * record a check, revise a criterion, advance a phase, clear a blocker or end the run. Every
 * change carries the card's version, so an agent write in between is refused as a conflict
 * rather than overwritten. The run's new view arrives on the thread's `offshift.updated` event,
 * as for an agent's change.
 */

/** An Offshift request the daemon refused, with its code (`conflict`, `invalid`, ...). */
export class OffshiftRefused extends Error {
  readonly code: NonNullable<OffshiftClientResult["error"]>;
  readonly view: OffshiftView | undefined;
  constructor(
    code: NonNullable<OffshiftClientResult["error"]>,
    message?: string,
    view?: OffshiftView,
  ) {
    super(message ?? `Offshift refused: ${code}`);
    this.name = "OffshiftRefused";
    this.code = code;
    this.view = view;
  }
}

async function ask(
  client: ClientApi,
  threadId: ThreadId,
  op: OffshiftPersonOperation,
  requestId: string,
  signal?: AbortSignal,
): Promise<OffshiftView | undefined> {
  const reply = await client.request(
    { type: "offshift.request", requestId, threadId, op },
    signal ? { signal } : {},
  );
  if (!reply.ok) throw new OffshiftRefused(reply.error ?? "unavailable", reply.message, reply.view);
  return reply.view;
}

/**
 * Send the person's change and resolve with the run's view when the daemon returns one.
 * `requestId` keys the daemon's receipt, so a retry after a lost response applies once.
 */
export function requestOffshift(
  client: ClientApi,
  threadId: ThreadId,
  op: OffshiftPersonOperation,
  options?: { requestId?: string | undefined; signal?: AbortSignal | undefined },
): Promise<OffshiftView | undefined> {
  return ask(client, threadId, op, options?.requestId ?? crypto.randomUUID(), options?.signal);
}
