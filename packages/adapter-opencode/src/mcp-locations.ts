import type { AceMcpConnection } from "@ace/mcp-server";
import type { OpenCodeClient } from "@opencode/client";
import { addAceMcp, connectAceMcp } from "./mcp-registration.ts";
import { waitForAceTools } from "./mcp-ready.ts";
import type { Runtime } from "./runtime.ts";

type Readiness = "ready" | "unconfirmed";

/**
 * ace's MCP server in each OpenCode location one session uses. Calls for the same location
 * share one piece of work, so two barriers never both add `ace`. Once ace added its server, a
 * failed connect or readiness check is retried later without adding it again: the server named
 * `ace` there is ace's own, not the person's.
 */
export class AceMcpLocations {
  private readonly states = new Map<string, Readiness>();
  private readonly added = new Set<string>();
  private readonly work = new Map<string, Promise<void>>();
  private readonly client: OpenCodeClient;
  private readonly connection: AceMcpConnection;
  private readonly runtime: Runtime;
  private readonly unconfirmed: () => void;
  constructor(options: {
    client: OpenCodeClient;
    connection: AceMcpConnection;
    runtime: Runtime;
    /** Called once per location whose tools could not be confirmed when it was set up. */
    unconfirmed: () => void;
  }) {
    this.client = options.client;
    this.connection = options.connection;
    this.runtime = options.runtime;
    this.unconfirmed = options.unconfirmed;
  }
  /** Sets ace up in `directory` unless that already succeeded; never re-checks readiness. */
  ensure(directory: string): Promise<void> {
    if (this.states.has(directory)) return Promise.resolve();
    return this.once(directory, () => this.setUp(directory));
  }
  /** Sets ace up, then looks once more (no retries) if its tools are still unconfirmed. */
  async admit(directory: string): Promise<void> {
    await this.ensure(directory);
    if (this.states.get(directory) !== "unconfirmed") return;
    await this.once(directory, async () => {
      this.states.set(directory, await waitForAceTools(this.client, directory, this.runtime, 0));
    });
  }
  private async setUp(directory: string): Promise<void> {
    if (!this.added.has(directory)) {
      // Pending set-ups count too, so concurrent new locations cannot pass the limit together.
      const others = new Set([...this.added, ...this.work.keys()]);
      others.delete(directory);
      if (others.size >= 128) throw new Error("OpenCode MCP location limit exceeded");
      await addAceMcp(this.client, directory, this.connection);
      this.added.add(directory);
    }
    await connectAceMcp(this.client, directory);
    const readiness = await waitForAceTools(this.client, directory, this.runtime);
    this.states.set(directory, readiness);
    if (readiness === "unconfirmed") this.unconfirmed();
  }
  private once(directory: string, run: () => Promise<void>): Promise<void> {
    const running = this.work.get(directory);
    if (running) return running;
    const started = run().finally(() => this.work.delete(directory));
    this.work.set(directory, started);
    return started;
  }
}
