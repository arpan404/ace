import { randomUUID } from "node:crypto";
import { Client, webSocketTransport, type Selection, type Storage } from "@ace/client";
import { CommandPayload, DeviceId, ThreadId, WorkspaceId, type Thread } from "@ace/protocol";
import { WebSocket } from "ws";

const turnTimeoutMs = 120_000;

function memoryStorage(): Storage {
  let saved: string | null = null;
  return {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
  };
}
function until<T>(selection: Selection<T>, accept: (value: T) => boolean, what: string) {
  return new Promise<T>((resolve, reject) => {
    const subscriptions: (() => void)[] = [];
    const finish = () => {
      clearTimeout(timer);
      for (const stop of subscriptions) stop();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`Timed out waiting for ${what}`));
    }, turnTimeoutMs);
    const check = () => {
      const value = selection.getSnapshot();
      if (!accept(value)) return;
      finish();
      resolve(value);
    };
    subscriptions.push(selection.subscribe(check));
    check();
  });
}

/**
 * The one subscribed client: it holds the thread list open like a sidebar, watches each
 * thread it drives like an open conversation, and starts turns through ordinary commands.
 */
export class Driver {
  readonly client: Client;
  private readonly sidebar: { release(): void };
  private constructor(client: Client) {
    this.client = client;
    this.sidebar = client.threads();
  }
  static async connect(origin: string, token: string): Promise<Driver> {
    const client = new Client({
      deviceId: DeviceId.parse("daemon-bench"),
      transport: () => webSocketTransport(() => new WebSocket(origin.replace("http:", "ws:"))),
      credential: async () => token,
      storage: memoryStorage(),
      scheduler: {
        set(ms, callback) {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      },
      random: Math.random,
      id: randomUUID,
      now: Date.now,
    });
    await client.start();
    const state = await until(
      client.connectionState(),
      (value) => value === "ready" || value === "fatal",
      "the daemon connection",
    );
    if (state === "fatal") throw client.error ?? new Error("Daemon refused the bench client");
    const driver = new Driver(client);
    await client.threadsWindow({});
    return driver;
  }
  private async command(payload: unknown) {
    const receipt = await this.client.command(CommandPayload.parse(payload));
    if (!receipt.ok) throw new Error(receipt.error ?? receipt.code ?? "Command refused");
    return receipt;
  }
  async addProject(path: string): Promise<WorkspaceId> {
    const receipt = await this.command({ type: "workspace.add", path });
    if (!receipt.workspace) throw new Error("Project registration returned no workspace");
    return WorkspaceId.parse(receipt.workspace.id);
  }
  /** Cumulative SQLite write transactions the daemon has committed. */
  async transactions(): Promise<number> {
    const receipt = await this.command({ type: "diagnostics.health" });
    const count = receipt.health?.streaming?.transactions;
    if (count === undefined) throw new Error("Daemon health has no storage counters");
    return count;
  }
  /** Starts a thread with its first turn and resolves once that turn has finished. */
  async createTurn(workspaceId: WorkspaceId, provider: Thread["provider"], text: string) {
    const threadId = ThreadId.parse(`bench-${randomUUID()}`);
    await this.command({
      type: "thread.create",
      workspaceId,
      threadId,
      provider,
      mode: "local",
      input: [{ type: "text", text }],
    });
    const lease = this.client.thread(threadId);
    try {
      await this.settled(lease.store, new Set());
    } finally {
      lease.release();
    }
    return threadId;
  }
  /** Keeps one thread open across turns, the way a person watches a long conversation. */
  watch(threadId: ThreadId) {
    const lease = this.client.thread(threadId);
    return {
      send: async (text: string) => {
        const before = new Set(lease.store.order);
        await this.command({
          type: "thread.send",
          threadId,
          input: [{ type: "text", text }],
          delivery: "queue",
        });
        await this.settled(lease.store, before);
      },
      release: () => lease.release(),
    };
  }
  /** Finished means a new assistant answer exists and the whole thread is done. */
  private async settled(
    store: ReturnType<Client["thread"]>["store"],
    before: ReadonlySet<string>,
  ): Promise<void> {
    const outcome = await until(
      // The reader is the store itself; every notification must be re-checked.
      store.select(
        ["thread", "order", "error"],
        (reader) => reader,
        () => false,
      ),
      (reader) => {
        if (reader.error) return true;
        const state = reader.thread?.status.state;
        if (state === "failed" || state === "needs_you" || state === "unresponsive") return true;
        const answered = reader.order.some((id) => {
          if (before.has(id)) return false;
          const item = reader.item(id);
          return item?.type === "message" && item.role === "assistant";
        });
        return answered && state === "done";
      },
      "a turn to finish",
    );
    if (outcome.error) throw outcome.error;
    const state = outcome.thread?.status.state;
    if (state !== "done") throw new Error(`Turn ended ${state ?? "without a thread"}`);
  }
  async close() {
    this.sidebar.release();
    await this.client.close();
  }
}
