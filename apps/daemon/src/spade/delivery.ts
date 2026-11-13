import { z } from "zod";
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
  /**
   * Whether the Spade at `connection` proves it holds its token (`proveSpade`), checked right
   * before each hand-over: neither the token nor a grant goes to a listener that can't.
   */
  prove(connection: SpadeConnection): Promise<boolean>;
  /** Spade's connection now, if it is ready. */
  ready(): SpadeConnection | undefined;
  /** Runs `run` after `ms`; returns a cancel. */
  after(ms: number, run: () => void): () => void;
  now(): number;
  log(level: "info" | "warn", message: string): void;
}

const aceState = z.object({ grant: z.boolean(), refused: z.boolean().optional() });

/** Retries a failed hand-over after 1 s, doubling, at most 30 s, while Spade stays ready. */
const retryMs = (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);

/**
 * Hands Spade's grant to Spade over its own API (contract, "Spade's grant for ace"):
 * `PUT /v1/ace {grant}` when the grant is made and whenever a Spade instance appears without it,
 * `DELETE /v1/ace` when it is revoked. Only a token's hash is stored, so each hand-over issues a
 * new token, reused until acknowledged. Refused credentials heal at most once a minute.
 */
export class SpadeGrantDelivery {
  private readonly options: SpadeDeliveryOptions;
  private queue: Promise<void> = Promise.resolve();
  private attempt = 0;
  private cancelRetry: (() => void) | undefined;
  private closed = false;
  // A timed-out PUT can still finish in Spade's keychain. Every retry must carry the same token.
  private pending: { grantId: string; token: string } | undefined;
  private nextMint = 0;
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
      if (!(await this.options.prove(connection))) {
        this.options.log("warn", "Spade didn't prove itself; its grant wasn't sent");
        this.retry();
        return;
      }
      const state = await this.state(connection);
      const refused = state?.refused === true;
      const handed = this.handed?.grantId === grant.id && this.handed.spade === spade;
      if (!this.pending && !state && this.handed?.grantId === grant.id) {
        this.checkLater();
        return;
      }
      if (
        !this.pending &&
        !refused &&
        state?.grant === true &&
        (handed || (!fresh && grant.lastUsedAt !== null))
      ) {
        this.attempt = 0;
        this.checkLater();
        return;
      }
      if (!this.pending && this.options.now() < this.nextMint) {
        this.checkLater();
        return;
      }
      if (this.pending?.grantId !== grant.id) {
        this.pending = { grantId: grant.id, token: this.options.grants.issue(grant) };
        this.nextMint = this.options.now() + 60_000;
        if (refused) this.options.log("info", "Replacing Spade's refused credential for ace");
      }
      const token = this.pending.token;
      const answer = await this.options.call(connection, "PUT", { grant: token });
      if (answer && answer.status >= 200 && answer.status < 300) {
        this.pending = undefined;
        this.attempt = 0;
        this.handed = { grantId: grant.id, spade };
        this.options.log("info", "Handed Spade its grant for ace");
        this.checkLater();
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
      this.pending = undefined;
      this.nextMint = 0;
      if (connection && (await this.options.prove(connection)))
        await this.options.call(connection, "DELETE");
    });
  }
  close(): void {
    this.closed = true;
    this.pending = undefined;
    this.cancelRetry?.();
  }
  private async state(
    connection: SpadeConnection,
  ): Promise<{ grant: boolean; refused: boolean } | undefined> {
    const answer = await this.options.call(connection, "GET");
    if (answer?.status !== 200) return undefined;
    const parsed = aceState.safeParse(answer.body);
    if (!parsed.success) return undefined;
    return { grant: parsed.data.grant, refused: parsed.data.refused === true };
  }

  private checkLater(): void {
    if (this.closed) return;
    this.cancelRetry = this.options.after(5000, () => {
      const connection = this.options.ready();
      if (connection) void this.deliver(connection);
    });
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
