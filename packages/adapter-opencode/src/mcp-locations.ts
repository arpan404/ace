import type { AceMcpConnection } from "@ace/mcp-server";
import type { OpenCodeClient } from "@opencode/client";
import { aceMcpListed, addAceMcp, connectAceMcp } from "./mcp-registration.ts";
import { waitForAceTools } from "./mcp-ready.ts";
import type { Runtime } from "./runtime.ts";

type Readiness = "ready" | "unconfirmed";
type Work = { generation: number; promise: Promise<void> };

/**
 * ace's MCP server in each OpenCode location one session uses. Calls for the same location
 * share one piece of work, so two barriers never both add `ace`. Once ace added its server, a
 * failed connect or readiness check is retried later without adding it again: the server named
 * `ace` there is ace's own, not the person's.
 *
 * OpenCode drops runtime MCP servers when it rebuilds a location (`location.shutdown`), so
 * `forget` starts a new generation: ace adds its server again, through the collision check, and
 * work begun before the rebuild can no longer record anything.
 */
export class AceMcpLocations {
  private readonly states = new Map<string, Readiness>();
  private readonly added = new Set<string>();
  private readonly adding = new Set<string>();
  /** Locations rebuilt while ace's add was in flight: an `ace` found there is ace's own. */
  private readonly uncertain = new Set<string>();
  private readonly work = new Map<string, Work>();
  private readonly generations = new Map<string, number>();
  private readonly client: OpenCodeClient;
  private readonly connection: AceMcpConnection;
  private readonly runtime: Runtime;
  private readonly unconfirmed: () => void;
  constructor(options: {
    client: OpenCodeClient;
    connection: AceMcpConnection;
    runtime: Runtime;
    /** Called once per location set-up whose tools could not be confirmed. */
    unconfirmed: () => void;
  }) {
    this.client = options.client;
    this.connection = options.connection;
    this.runtime = options.runtime;
    this.unconfirmed = options.unconfirmed;
  }
  /** Sets ace up in `directory` unless that already succeeded; never re-checks readiness. */
  async ensure(directory: string): Promise<void> {
    // Work from before a rebuild finishes first, then this generation's set-up runs.
    while (!this.states.has(directory))
      await this.once(directory, (generation) => this.setUp(directory, generation));
  }
  /** Sets ace up, then looks once more (no retries) if its tools are still unconfirmed. */
  async admit(directory: string): Promise<void> {
    for (;;) {
      await this.ensure(directory);
      if (this.states.get(directory) !== "unconfirmed") return;
      const generation = this.generation(directory);
      await this.once(directory, async (current) => {
        const readiness = await waitForAceTools(this.client, directory, this.runtime, 0);
        if (this.current(directory, current)) this.states.set(directory, readiness);
      });
      // A rebuild during the check means ace must be set up again before input goes out.
      if (this.current(directory, generation)) return;
    }
  }
  /** OpenCode rebuilt this location and lost ace's server there. */
  forget(directory: string): void {
    this.generations.set(directory, this.generation(directory) + 1);
    this.states.delete(directory);
    this.added.delete(directory);
    // The add may land in the rebuilt services. The location listed no `ace` before ace's
    // add, so one found there next is ace's own, not the person's.
    if (this.adding.has(directory)) this.uncertain.add(directory);
  }
  private async setUp(directory: string, generation: number): Promise<void> {
    if (!this.added.has(directory)) {
      const listed = await aceMcpListed(this.client, directory);
      if (!this.current(directory, generation)) return;
      if (listed && !this.uncertain.has(directory))
        throw new Error("OpenCode MCP server name collision: ace");
      if (!listed) {
        // A set-up holds its slot while it adds, so concurrent new locations cannot pass the
        // limit together.
        if (new Set([...this.added, ...this.adding]).size >= 128)
          throw new Error("OpenCode MCP location limit exceeded");
        this.adding.add(directory);
        try {
          await addAceMcp(this.client, directory, this.connection);
        } finally {
          this.adding.delete(directory);
        }
        if (!this.current(directory, generation)) return;
      }
      this.added.add(directory);
      this.uncertain.delete(directory);
    }
    await connectAceMcp(this.client, directory);
    const readiness = await waitForAceTools(this.client, directory, this.runtime);
    if (!this.current(directory, generation)) return;
    this.states.set(directory, readiness);
    if (readiness === "unconfirmed") this.unconfirmed();
  }
  /**
   * Runs `run` unless this generation's work for `directory` is already running, in which case
   * callers share it, failure included. Work from an older generation is awaited first.
   */
  private once(directory: string, run: (generation: number) => Promise<void>): Promise<void> {
    const generation = this.generation(directory);
    const running = this.work.get(directory);
    if (running?.generation === generation) return running.promise;
    const previous = running?.promise.catch(() => {}) ?? Promise.resolve();
    const promise = previous
      // Work queued behind a rebuild that came after it has nothing left to do.
      .then(() => (this.current(directory, generation) ? run(generation) : undefined))
      .finally(() => {
        if (this.work.get(directory)?.promise === promise) this.work.delete(directory);
      });
    this.work.set(directory, { generation, promise });
    return promise;
  }
  private generation(directory: string): number {
    return this.generations.get(directory) ?? 0;
  }
  private current(directory: string, generation: number): boolean {
    return this.generation(directory) === generation;
  }
}
