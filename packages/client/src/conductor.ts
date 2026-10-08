import type { ConductorRunView, ConductorSummary } from "@ace/protocol";
import type { ClientApi } from "./api.ts";
import { Notifications, type Selection } from "./observable.ts";
import { ClientError } from "./types.ts";
import type { RequestOptions } from "./types.ts";

export interface ConductorWatch {
  run: Selection<ConductorRunView | undefined>;
  error: Selection<Error | undefined>;
  close(): void;
}
/** Typed Deck reads and a push subscription that reacquires its snapshot after reconnect. */
export class ConductorClient {
  private client: ClientApi;
  private id: () => string;
  private watches = 0;
  constructor(client: ClientApi, id: () => string) {
    this.client = client;
    this.id = id;
  }
  async get(runId: string, options?: RequestOptions): Promise<ConductorRunView> {
    const reply = await this.client.request(
      { type: "conductor.request", operation: { op: "get", runId } },
      options,
    );
    if (!reply.ok || !reply.run)
      throw new ClientError("daemon", reply.error ?? "conductor_run_missing");
    return reply.run;
  }
  async list(
    input: { after?: string; limit?: number; active?: boolean } = {},
    options?: RequestOptions,
  ): Promise<{ runs: ConductorSummary[]; next?: string }> {
    const reply = await this.client.request(
      {
        type: "conductor.request",
        operation: {
          op: "list",
          limit: input.limit ?? 16,
          ...(input.after ? { after: input.after } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
      },
      options,
    );
    if (!reply.ok) throw new ClientError("daemon", reply.error);
    return { runs: reply.runs ?? [], ...(reply.next ? { next: reply.next } : {}) };
  }
  watch(runId: string): ConductorWatch {
    if (this.watches >= 8) throw new ClientError("limit", "conductor_watch_limit");
    this.watches++;
    const client = this.client;
    const subscriptionId = this.id();
    const run = cell<ConductorRunView | undefined>(undefined);
    const error = cell<Error | undefined>(undefined);
    const connection = client.connectionState();
    let closed = false;
    let generation = 0;
    let push = 0;
    let abort: AbortController | undefined;
    const refresh = () => {
      const epoch = ++generation;
      abort?.abort();
      if (closed || connection.getSnapshot() !== "ready") return;
      abort = new AbortController();
      const initialPush = push;
      void client
        .request(
          { type: "conductor.request", operation: { op: "subscribe", runId, subscriptionId } },
          { signal: abort.signal },
        )
        .then((reply) => {
          if (closed || epoch !== generation) return;
          if (!reply.ok || !reply.run)
            throw new ClientError("daemon", reply.error ?? "conductor_run_missing");
          if (push === initialPush) run.set(reply.run);
          error.set(undefined);
        })
        .catch((cause: unknown) => {
          if (!closed && epoch === generation)
            error.set(cause instanceof Error ? cause : new ClientError("daemon"));
        });
    };
    const stopMessages = client.onMessage((message) => {
      if (
        !closed &&
        message.type === "conductor.changed" &&
        message.subscriptionId === subscriptionId &&
        message.run.id === runId
      ) {
        push++;
        run.set(message.run);
        error.set(undefined);
      }
    });
    const stopConnection = connection.subscribe(refresh);
    refresh();
    return {
      run: run.selection,
      error: error.selection,
      close: () => {
        if (closed) return;
        closed = true;
        generation++;
        this.watches--;
        abort?.abort();
        stopMessages();
        stopConnection();
        if (client.state === "ready")
          void client
            .request({
              type: "conductor.request",
              operation: { op: "unsubscribe", subscriptionId },
            })
            .catch(() => {});
      },
    };
  }
}
function cell<T>(initial: T) {
  let value = initial;
  const notifications = new Notifications(256);
  return {
    selection: notifications.select(["value"], () => value),
    set(next: T) {
      value = next;
      notifications.emit(["value"]);
    },
  };
}
