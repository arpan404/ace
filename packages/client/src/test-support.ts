import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, createDevThread, type CommandHandler } from "@ace/daemon";
import {
  AgentId,
  ItemId,
  DeviceId,
  ServerMessage,
  type ThreadId,
  type EventPayload,
  type ServerMessage as Message,
} from "@ace/protocol";
import {
  Client,
  webSocketTransport,
  type Storage,
  type Scheduler,
  type Transport,
  type TransportEvents,
  type Selection,
  type ClientOptions,
} from "./index.ts";

export class ManualScheduler implements Scheduler {
  private now = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback(): void }>();
  set(delay: number, callback: () => void): () => void {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, callback });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = until;
  }
}
export function when<T>(selection: Selection<T>, predicate: (value: T) => boolean): Promise<T> {
  if (predicate(selection.getSnapshot())) return Promise.resolve(selection.getSnapshot());
  return new Promise((resolve) => {
    const stop = selection.subscribe(() => {
      const value = selection.getSnapshot();
      if (predicate(value)) {
        stop();
        resolve(value);
      }
    });
  });
}
export function memoryStorage(): Storage {
  let saved: string | null = null;
  return {
    async load() {
      return saved;
    },
    async save(value) {
      saved = value;
    },
  };
}
export class Faults {
  private transport: Transport | undefined;
  private events: TransportEvents | undefined;
  private messages: Message[] = [];
  private watchers: { predicate(message: Message): boolean; resolve(message: Message): void }[] =
    [];
  incoming: (message: Message, text: string, deliver: (text: string) => void) => void = (
    _message,
    text,
    deliver,
  ) => deliver(text);
  sent: string[] = [];
  constructor(privateUrl: string) {
    this.url = privateUrl;
  }
  private url: string;
  create(): Transport {
    const inner = webSocketTransport(() => new WebSocket(this.url));
    this.transport = inner;
    return {
      open: (events) => {
        this.events = events;
        inner.open({
          open: events.open,
          close: events.close,
          message: (text) => {
            const message = ServerMessage.parse(JSON.parse(text));
            this.messages.push(message);
            for (const watcher of this.watchers.slice())
              if (watcher.predicate(message)) {
                this.watchers.splice(this.watchers.indexOf(watcher), 1);
                watcher.resolve(message);
              }
            this.incoming(message, text, events.message);
          },
        });
      },
      send: (text) => {
        this.sent.push(text);
        inner.send(text);
      },
      close: () => inner.close(),
    };
  }
  disconnect(): void {
    this.transport?.close();
    this.events?.close(1006);
  }
  wait(predicate: (message: Message) => boolean): Promise<Message> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.watchers.push({ predicate, resolve }));
  }
}
export async function setup(handler?: CommandHandler) {
  const directory = await mkdtemp(join(tmpdir(), "ace-client-"));
  const daemon = await startDaemon(
    {
      dataDir: directory,
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
    },
    handler,
  );
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  const workspaceId = daemon.store.createWorkspace(directory, "test");
  const thread = createDevThread(daemon.store, workspaceId);
  const clients: Client[] = [];
  let sequence = 0;
  const make = (overrides: Partial<ClientOptions> = {}) => {
    const faults = new Faults(daemon.url);
    const scheduler = new ManualScheduler();
    const client = new Client({
      deviceId: DeviceId.parse("test-device"),
      transport: () => faults.create(),
      storage: memoryStorage(),
      credential: async () => token,
      scheduler,
      random: () => 0.5,
      id: () => `client-${++sequence}`,
      ...overrides,
    });
    clients.push(client);
    return { client, faults, scheduler };
  };
  const storage: Storage = {
    async load() {
      try {
        return await readFile(join(directory, "outbox.json"), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(value) {
      const temporary = join(directory, "outbox.tmp");
      await writeFile(temporary, value);
      await rename(temporary, join(directory, "outbox.json"));
    },
  };
  return {
    daemon,
    thread,
    workspaceId,
    make,
    storage,
    async cleanup() {
      for (const client of clients) await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function ready(client: Client): Promise<void> {
  await client.start();
  await when(client.connectionState(), (state) => state === "ready");
}
export async function barrier(client: Client, threadId: ThreadId): Promise<void> {
  await client.itemsPage({ threadId, limit: 1 });
}
export const itemId = ItemId.parse("message");
export const agentId = AgentId.parse("agent");
export const message = {
  type: "item.created",
  item: {
    type: "message",
    id: itemId,
    agentId,
    role: "assistant",
    complete: false,
    createdAt: 1,
    parts: [{ type: "text", text: "" }],
    synthetic: false,
    raw: [],
  },
} satisfies EventPayload;
export const delta = (append: string): EventPayload => ({
  type: "item.delta",
  itemId,
  agentId,
  field: "text",
  append,
});
export function itemText(item: import("@ace/protocol").Item | undefined): string {
  return item?.type === "message"
    ? item.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : "";
}
