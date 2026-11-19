import { Client, type ClientOptions } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import { DeviceId, ThreadId, type DeviceScope } from "@ace/protocol";
import type { PatchSink } from "./agents.ts";

/** Test support: a real SDK client on the fake daemon, and a sink that reads like native. */
export function sheetFixture(
  options: {
    scopes?: readonly DeviceScope[];
    /** A machine whose daemon predates placement: its lists carry no places. */
    olderDaemon?: boolean;
    /** The client's subscription limits, for tests of room for optional threads. */
    limits?: ClientOptions["limits"];
  } = {},
) {
  let now = 1_000;
  let ids = 0;
  const daemon = new FakeDaemon({
    clock: () => (now += 1),
    // A paired phone with these scopes; without, the fixture's device may do everything.
    ...(options.scopes ? { deviceScopes: { "ios-sheet-device": options.scopes } } : {}),
    ...(options.olderDaemon ? { placement: false as const } : {}),
  });
  const client = new Client({
    deviceId: DeviceId.parse("ios-sheet-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++ids}`,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { daemon, client };
}

/** Keeps the latest reader per key, as the pump does, and reads it when the test looks. */
export class RecordingSink implements PatchSink {
  readonly readers = new Map<string, () => Record<string, unknown> | undefined>();
  puts = 0;
  put(key: string, read: () => Record<string, unknown> | undefined): void {
    this.puts++;
    this.readers.set(key, read);
  }
  clear(prefix: string): void {
    for (const key of this.readers.keys()) if (key.startsWith(prefix)) this.readers.delete(key);
  }
  read(key: string): Record<string, unknown> | undefined {
    return this.readers.get(key)?.();
  }
}

export const plainPreview = (text: string, limit: number) => text.slice(0, limit);

export async function until(condition: () => boolean, label: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out: ${label}`);
}

/**
 * A parent whose child on Studio lost its pairing (ADR 0099), as the daemon reports it: the
 * child's summary agent, and the daemon's request about it, `lost`, on that agent.
 */
export function lostChild(child: string): { agent: string; facts: Fact[] } {
  const agent = `ace-child:${child}`;
  return {
    agent,
    facts: [
      {
        type: "agent.seen",
        agent,
        parent: "root",
        origin: "ace",
        fidelity: "summary",
        native: { provider: "claude" },
        cwd: "",
        role: "reviewer",
        machine: { machine: "studio", name: "Studio" },
      },
      {
        type: "agent.external",
        agent,
        threadId: ThreadId.parse(child),
        status: { state: "working", agents: 1 },
      },
      {
        type: "interaction.opened",
        agent,
        interaction: "lost",
        blocking: true,
        request: {
          kind: "approval",
          title: "Lost: Studio is no longer paired; its work there may still be running.",
          description: "Pair Studio again to keep tracking reviewer, or stop tracking it here.",
          options: [
            {
              id: "stop-tracking",
              label: "Stop tracking; its work on Studio may still be running",
              kind: "cancel",
            },
          ],
        },
        raw: [{ type: "ace.machine.lost", data: { machine: "studio", threadId: child } }],
      },
    ],
  };
}
