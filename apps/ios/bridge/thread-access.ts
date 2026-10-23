import type { ClientCore, ThreadSource } from "@ace/client";
import {
  AccessMode,
  ThreadId,
  type AccessModeOffer,
  type CommandPayload,
  type ProviderKind,
} from "@ace/protocol";
import { accessChoices, providerNames, threadAccessSummary } from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";
import { z } from "zod";

/*
 * The open thread's access control, as the web composer's: the mode in effect (or the one picked
 * to replace it, which applies at the agent's next turn), the modes its provider supports
 * (`threadAccessSummary`, `accessChoices`), and the durable `thread.permission.set` that changes
 * it. The pick shows at once and stays until the thread's permission state moves; a choice also
 * becomes this daemon's default for new threads, as on the web.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
type Dispatch = (payload: CommandPayload, id: string) => void;
type Offers = { state: "loading" | "ready" | "failed"; offers: readonly AccessModeOffer[] };

const quiet = { timeoutMs: 15_000 };
const SettingEntries = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
});

export class ThreadAccessFollower {
  readonly #client: Pick<ClientCore, "request">;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #put: Put;
  readonly #dispatch: Dispatch;
  #daemonDefault: AccessMode | undefined;
  #offers: Offers = { state: "loading", offers: [] };
  #offersFor = "";
  /** The mode picked here (null: back to the default) and the state it was picked against. */
  #chosen: { mode: AccessMode | null; against: string } | undefined;

  constructor(
    client: Pick<ClientCore, "request">,
    store: ThreadSource,
    threadId: ThreadId,
    put: Put,
    dispatch: Dispatch,
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = threadId;
    this.#put = put;
    this.#dispatch = dispatch;
    void this.#readDefault();
  }

  /** The thread changed: its provider's modes, the state a pick waits on, the control. */
  update(): void {
    const state = JSON.stringify(this.#store.thread?.permission ?? null);
    if (this.#chosen && this.#chosen.against !== state) this.#chosen = undefined;
    this.#follow();
    this.#emit();
  }

  /** Change the thread's access; the daemon applies it at the agent's next turn. */
  set(mode: AccessMode | null, id: string): void {
    this.#chosen = { mode, against: JSON.stringify(this.#store.thread?.permission ?? null) };
    this.#emit();
    this.#dispatch({ type: "thread.permission.set", threadId: this.#threadId, access: mode }, id);
    if (mode)
      void this.#client
        .request({
          type: "settings.set",
          key: "access.defaultMode",
          value: mode,
          layer: { kind: "global" },
        })
        .catch(() => undefined);
  }

  /** Live modes from the thread's capabilities, else the provider account's, read once. */
  #follow(): void {
    const thread = this.#store.thread;
    const live = (thread?.effectiveCapabilities ?? thread?.capabilities)?.accessModes;
    if (live) {
      this.#offers = { state: "ready", offers: live };
      return;
    }
    const selection = runsOn(thread);
    const provider = selection?.provider ?? thread?.provider;
    const key = `${provider ?? ""}\u0000${selection?.instanceId ?? ""}`;
    if (!provider || key === this.#offersFor) return;
    this.#offersFor = key;
    this.#offers = { state: "loading", offers: [] };
    void this.#readOffers(provider, selection?.instanceId, key);
  }

  async #readOffers(provider: ProviderKind, instanceId: string | undefined, key: string) {
    try {
      const reply = await this.#client.request(
        { type: "permissions.capabilities", provider, ...(instanceId ? { instanceId } : {}) },
        quiet,
      );
      if (!reply.ok) throw new Error(reply.error ?? "unavailable");
      if (key === this.#offersFor)
        this.#offers = { state: "ready", offers: reply.accessModes ?? [] };
    } catch {
      if (key === this.#offersFor) {
        this.#offers = { state: "failed", offers: [] };
        this.#offersFor = "";
      }
    }
    this.#emit();
  }

  async #readDefault(): Promise<void> {
    try {
      const reply = await this.#client.request(
        { type: "settings.get", key: "access.defaultMode", scope: {} },
        quiet,
      );
      const entry = SettingEntries.parse(reply).entries.find(
        (candidate) => candidate.key === "access.defaultMode",
      );
      const mode = AccessMode.safeParse(entry?.value);
      this.#daemonDefault = mode.success ? mode.data : undefined;
    } catch {
      this.#daemonDefault = undefined;
    }
    this.#emit();
  }

  #emit(): void {
    this.#put("access", () => {
      const thread = this.#store.thread;
      if (!thread) return undefined;
      // A thread whose daemon reports no permission state has no access to change.
      if (!thread.permission) return { type: "thread.access", state: "none", choices: [] };
      const summary = threadAccessSummary(thread.permission, this.#offers.offers, {
        chosen: this.#chosen?.mode,
        defaultMode: this.#daemonDefault,
        provider: providerNames[thread.provider],
      });
      const choices = accessChoices(this.#offers.offers);
      return {
        type: "thread.access",
        state: this.#offers.state,
        label: summary ? (summary.next ? labelOf(choices, summary.next) : summary.label) : "Access",
        selected: summary?.next ?? summary?.mode ?? null,
        pending: !!summary?.next,
        custom: summary?.custom ?? null,
        stricter: summary?.stricter ?? null,
        choices,
      };
    });
  }
}

function labelOf(choices: readonly { mode: AccessMode; label: string }[], mode: AccessMode) {
  return choices.find((choice) => choice.mode === mode)?.label ?? mode;
}
