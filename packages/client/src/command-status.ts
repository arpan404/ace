import { CoreClientMessage, CoreServerMessage, type CommandStatusState } from "@ace/protocol";
import type { ClientMessage } from "@ace/protocol";
import type { Requests } from "./requests.ts";
import { ClientError, type Scheduler } from "./types.ts";

/** At most this many command ids per `command.status` request. */
const batch = 64;

export interface CommandStatusReport {
  commandId: string;
  state: CommandStatusState;
}
interface CommandStatusOptions {
  scheduler: Scheduler;
  /** How long a sent command may go without a receipt before the daemon is asked about it. */
  boundMs: number;
  /** Sent on this connection, no receipt yet, not delivered, and no retry waiting. */
  awaiting(id: string): boolean;
  /** Ask the daemon; rejects when it can't or won't say. */
  ask(ids: readonly string[]): Promise<readonly CommandStatusReport[]>;
  /** The daemon has no record of the command and isn't running it. */
  lost(id: string): void;
}

/**
 * Durable commands wait for their receipt across reconnects, but a daemon that restarted
 * without one may never send it. A command sent on a live connection that goes `boundMs`
 * without a receipt is asked after with `command.status`: one the daemon has no record of
 * fails, one it is still running waits another `boundMs`. A daemon that can't answer (an older
 * build refuses the message, or the reply doesn't come in time) isn't asked again on this
 * connection, and nothing fails because of it.
 */
export class CommandStatusChecks {
  #options: CommandStatusOptions;
  #timers = new Map<string, () => void>();
  #due = new Set<string>();
  #flush: (() => void) | undefined;
  #connection = 0;
  #unsupported = false;
  constructor(options: CommandStatusOptions) {
    this.#options = options;
  }
  /** The command just went out on the current connection. */
  sent(id: string): void {
    this.#arm(id);
  }
  /** It has its receipt, or won't be waited on any more. */
  settled(id: string): void {
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    this.#due.delete(id);
  }
  /** The connection ended: checks start over on the next one, which may be a newer daemon. */
  disconnect(): void {
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
    this.#due.clear();
    this.#flush?.();
    this.#flush = undefined;
    this.#connection++;
    this.#unsupported = false;
  }
  #arm(id: string): void {
    if (this.#unsupported) return;
    this.#timers.get(id)?.();
    this.#timers.set(
      id,
      this.#options.scheduler.set(this.#options.boundMs, () => {
        this.#timers.delete(id);
        this.#due.add(id);
        // Commands sent together come due together and share one request.
        this.#flush ??= this.#options.scheduler.set(0, () => {
          this.#flush = undefined;
          this.#check();
        });
      }),
    );
  }
  #check(): void {
    const ids = [...this.#due].filter((id) => this.#options.awaiting(id));
    this.#due.clear();
    if (this.#unsupported) return;
    const connection = this.#connection;
    for (let start = 0; start < ids.length; start += batch) {
      const asked = ids.slice(start, start + batch);
      this.#options.ask(asked).then(
        (reports) => {
          if (connection !== this.#connection) return;
          const states = new Map(reports.map((report) => [report.commandId, report.state]));
          for (const id of asked) {
            if (!this.#options.awaiting(id)) continue;
            const state = states.get(id);
            // `settled`: its receipt came ahead of the reply. An id the reply left out waits.
            if (state === "unknown") this.#options.lost(id);
            else if (state !== "settled") this.#arm(id);
          }
        },
        () => {
          if (connection === this.#connection) this.#unsupported = true;
        },
      );
    }
  }
}

/** One `command.status` request through the bounded request map, with its reply checked. */
export function askCommandStatus(
  requests: Requests,
  send: (message: ClientMessage) => boolean,
  requestId: string,
  commandIds: readonly string[],
): Promise<readonly CommandStatusReport[]> {
  const parsed = CoreClientMessage.safeParse({ type: "command.status", requestId, commandIds });
  if (!parsed.success) return Promise.reject(new ClientError("protocol", "Invalid status ask"));
  return requests.wait(
    requestId,
    (value) => {
      const reply = CoreServerMessage.parse(value);
      if (reply.type !== "command.status" || reply.requestId !== requestId)
        throw new ClientError("protocol");
      return reply.commands;
    },
    {},
    () => {
      if (!send(parsed.data)) throw new ClientError("offline");
    },
  );
}
