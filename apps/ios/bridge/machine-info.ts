import type { ClientCore } from "@ace/client";
import { machineConnection, machineProviders } from "@ace/ui-core/mobile";
import { host } from "./host.ts";
import { connectionProblem, type TrustMonitor } from "./access.ts";
import { preview } from "./presentation.ts";
import type { PatchPump } from "./patch-pump.ts";

/*
 * What the Machines sheet shows about this runtime's computer: its connection in one word with
 * when it was last ready, and on request the CLIs it reports with their sign-in and usage.
 * Words come from `@ace/ui-core/mobile`; Swift formats the times and draws.
 */

/**
 * Connection word and when this phone last saw the computer: now while connected, else the
 * moment the connection dropped. Re-sent whenever the SDK's connection info changes.
 */
export function followMachine(owner: ClientCore, pump: PatchPump, trust: TrustMonitor): () => void {
  const info = owner.connectionInfo();
  let ready = false;
  let seenAt: number | null = null;
  const send = () => {
    const state = info.getSnapshot().state;
    if (state === "ready" || ready) seenAt = host.now();
    ready = state === "ready";
    pump.put("machine:status", () => {
      const current = info.getSnapshot();
      const problem = connectionProblem(current.state, owner.error, trust);
      return {
        type: "machine.status",
        status: machineConnection(current.state, problem?.code),
        seenAt,
      };
    });
  };
  const stop = info.subscribe(send);
  send();
  return stop;
}

const quiet = { timeoutMs: 15_000 };

/**
 * Reads the machine's CLIs and usage once connected; a request made while offline runs on the
 * next ready connection. A machine that refuses its accounts still lists its CLIs.
 */
/** What reading the machine's CLIs needs of the SDK client. */
export type ProvidersOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage">;

export class MachineProviders {
  #owner: ProvidersOwner;
  #pump: PatchPump;
  #wanted = false;
  #loading = false;
  #stop: () => void;
  /** The last rows read, kept on screen when a later read fails. */
  #last: { providers: unknown[]; absent: unknown[]; version: string | null } | undefined;
  constructor(owner: ProvidersOwner, pump: PatchPump) {
    this.#owner = owner;
    this.#pump = pump;
    const connection = owner.connectionState();
    const stopConnection = connection.subscribe(() => {
      if (connection.getSnapshot() === "ready" && this.#wanted) void this.#load();
    });
    // The daemon says when its CLIs or accounts change; a screen showing them reads again.
    const stopEvents = owner.onMessage((message) => {
      if (
        this.#wanted &&
        (message.type === "providers.changed" || message.type === "accounts.changed")
      )
        void this.#load();
    });
    this.#stop = () => {
      stopConnection();
      stopEvents();
    };
  }
  refresh(): void {
    this.#wanted = true;
    if (this.#owner.connectionState().getSnapshot() === "ready") void this.#load();
  }
  dispose(): void {
    this.#stop();
  }
  async #load(): Promise<void> {
    if (this.#loading) return;
    this.#loading = true;
    try {
      const [providers, accounts, identity] = await Promise.allSettled([
        this.#owner.request(
          { type: "providers.request", operation: "readiness", requestId: host.uuid() },
          quiet,
        ),
        this.#owner.request({ type: "accounts.list", requestId: host.uuid() }, quiet),
        this.#owner.request({ type: "host.identity", requestId: host.uuid() }, quiet),
      ]);
      const result = providers.status === "fulfilled" ? providers.value.result : undefined;
      const listed = accounts.status === "fulfilled" ? accounts.value.accounts : [];
      const rows = result?.ok ? machineProviders(result.providers, listed, host.now()) : undefined;
      const shown = rows
        ? {
            providers: rows.providers.map((row) => ({
              provider: row.provider,
              status: row.status,
              name: preview(row.name, 128),
              summary: preview(row.summary, 512),
              version: row.version ? preview(row.version, 64) : null,
              usage: row.usage.slice(0, 8),
            })),
            absent: rows.absent,
            version:
              identity.status === "fulfilled" ? preview(identity.value.identity.version, 64) : null,
          }
        : (this.#last ?? { providers: [], absent: [], version: null });
      if (rows) this.#last = shown;
      this.#pump.put("machine:providers", () => ({
        type: "machine.providers",
        ...shown,
        problem: rows
          ? null
          : result && !result.ok && result.error === "forbidden"
            ? "This computer doesn't share its coding tools with this phone."
            : "Couldn't read this computer's coding tools. Pull to try again.",
      }));
    } finally {
      this.#loading = false;
    }
  }
}
