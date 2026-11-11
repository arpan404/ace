import type { OutsideGrant } from "@ace/protocol";
import type { SpadeConnection } from "./forward.ts";

/** One request to Spade's `/v1/ace`; undefined when Spade couldn't be reached. */
export type SpadeAceCall = (
  connection: SpadeConnection,
  method: "GET" | "PUT" | "DELETE",
  body?: { grant: string },
) => Promise<{ status: number; body: unknown } | undefined>;

export interface SpadeDeliveryOptions {
  grants: { current(): OutsideGrant | undefined; issue(grant: OutsideGrant): string };
  call: SpadeAceCall;
  /** Spade's connection now, if it is ready. */
  ready(): SpadeConnection | undefined;
  /** Runs `run` after `ms`; returns a cancel. */
  after(ms: number, run: () => void): () => void;
  log(level: "info" | "warn", message: string): void;
}

/** Retries a failed hand-over after 1 s, doubling, at most 30 s, while Spade stays ready. */
const retryMs = (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);

/**
 * Hands Spade's grant to Spade over its own API (contract, "Spade's grant for ace"):
 * `PUT /v1/ace {grant}` when the grant is made and whenever a Spade instance appears without it,
 * `DELETE /v1/ace` when it is revoked. Only a token's hash is stored, so each hand-over issues a
 * new token; a token Spade has used is left alone while Spade says it holds a grant.
 */
export class SpadeGrantDelivery {
  private readonly options: SpadeDeliveryOptions;
  private queue: Promise<void> = Promise.resolve();
  private attempt = 0;
  private cancelRetry: (() => void) | undefined;
  private closed = false;
  /** The grant last handed over, and to which Spade instance (its address and API token). */
  private handed: { grantId: string; spade: string } | undefined;
  constructor(options: SpadeDeliveryOptions) {
    this.options = options;
  }
  /**
   * Makes sure Spade at `connection` holds the live grant. `fresh`: the grant was just made, so
   * Spade can't have it yet.
   */
  deliver(connection: SpadeConnection, fresh = false): Promise<void> {
    return this.serial(async () => {
      this.cancelRetry?.();
      this.cancelRetry = undefined;
      const grant = this.options.grants.current();
      if (!grant || this.closed) return;
      const spade = `${connection.host}:${connection.port}:${connection.token}`;
      // Already handed to this very Spade: a second token would only revoke the first.
      if (this.handed?.grantId === grant.id && this.handed.spade === spade) return;
      if (!fresh && grant.lastUsedAt !== null && (await this.holds(connection))) {
        this.attempt = 0;
        return;
      }
      const token = this.options.grants.issue(grant);
      const answer = await this.options.call(connection, "PUT", { grant: token });
      if (answer && answer.status >= 200 && answer.status < 300) {
        this.attempt = 0;
        this.handed = { grantId: grant.id, spade };
        this.options.log("info", "Handed Spade its grant for ace");
        return;
      }
      if (answer?.status === 404) {
        // A Spade from before grants: nothing to retry until a newer one starts.
        this.options.log("warn", "This Spade can't take a grant for ace; its ace tools stay off");
        return;
      }
      this.options.log(
        "warn",
        `Spade didn't take its grant for ace (${answer ? `HTTP ${answer.status}` : "unreachable"}); trying again`,
      );
      this.retry();
    });
  }
  /** Tells Spade to forget its grant; Spade not running is fine, its token no longer works. */
  withdraw(connection: SpadeConnection | undefined): Promise<void> {
    return this.serial(async () => {
      this.cancelRetry?.();
      this.cancelRetry = undefined;
      this.attempt = 0;
      this.handed = undefined;
      if (connection) await this.options.call(connection, "DELETE");
    });
  }
  close(): void {
    this.closed = true;
    this.cancelRetry?.();
  }
  private async holds(connection: SpadeConnection): Promise<boolean> {
    const answer = await this.options.call(connection, "GET");
    const body = answer?.body;
    return (
      answer?.status === 200 &&
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "grant") === true
    );
  }
  private retry(): void {
    if (this.closed) return;
    const delay = retryMs(this.attempt++);
    this.cancelRetry = this.options.after(delay, () => {
      const connection = this.options.ready();
      if (connection) void this.deliver(connection, true);
    });
  }
  private serial(run: () => Promise<void>): Promise<void> {
    const next = this.queue.then(run).catch((error: unknown) => {
      this.options.log("warn", `Handing Spade its grant failed: ${String(error)}`);
    });
    this.queue = next;
    return next;
  }
}
