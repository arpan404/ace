import type { ClientCore, ThreadSource } from "@ace/client";
import type { CommandPayload, ProviderKind, ThreadId } from "@ace/protocol";
import {
  catalogModelIds,
  choiceSelection,
  continuationNote,
  isBusy,
  modelChoices,
  modelKey,
  modelLabel,
  providerNames,
  selectionInputs,
  switchNextTurnNote,
  type AttachmentReader,
  type ModelChoice,
} from "@ace/ui-core";
import { runsOn, selectionIdentity } from "@ace/ui-core/thread-execution";
import { z } from "zod";
import { readAgents, type AgentRead } from "./agent-read.ts";
import type { Preview } from "./agents.ts";
import { ModelFavorites } from "./model-favorites.ts";
import { pickerRows } from "./new-thread-agents.ts";
import {
  pickedChoice,
  switchPayload,
  switchPlan,
  switchRows,
  type SwitchScene,
  type SwitchTarget,
} from "./thread-switch.ts";

/*
 * The open thread's model sheet (`thread.models`): Favorites and one tab per account of every
 * coding agent set up on the machine, as New thread lists them, each row saying what picking it
 * does (`thread-switch.ts`). Holds a switch sent from here until the daemon reports it, and a
 * model the next message continues on in a new thread, so the composer names them meanwhile.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
/** Sends `payload` under `id`: `refused` runs when it isn't saved or the daemon turns it down. */
export type Dispatch = (payload: CommandPayload, id: string, refused: () => void) => void;
type Admission = (id: string, ok: boolean, message: string) => void;

const SettingEntries = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
});

const unconfirmed = "Confirm the move first.";

/** What the composer's model control names instead of what the thread runs on. */
export interface NextModel {
  provider: ProviderKind;
  model: string;
  note: string;
  continues: boolean;
}

export class ThreadModelSheet {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #signal: AbortSignal;
  readonly #put: Put;
  readonly #now: () => number;
  readonly #preview: Preview;
  readonly #changed: () => void;
  readonly #favorites: ModelFavorites;
  #state = "idle";
  #read: AgentRead | undefined;
  #choices: ModelChoice[] = [];
  #starProblem: string | null = null;
  #forkOnSwitch: boolean | undefined;
  /** A switch sent from here, and how the thread stood when it was sent. */
  #chosen: { choice: ModelChoice; stood: string } | undefined;
  #continued: ModelChoice | undefined;
  /** What the rows were last worked out for: the thread's selection, switch and busyness. */
  #shaped = "";

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: ThreadId,
    signal: AbortSignal,
    io: { put: Put; now: () => number; preview: Preview; changed: () => void },
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = threadId;
    this.#signal = signal;
    this.#put = io.put;
    this.#now = io.now;
    this.#preview = io.preview;
    this.#changed = io.changed;
    this.#favorites = new ModelFavorites(client);
  }

  /** The model the next message continues on in a new thread, if one was picked. */
  get continued(): ModelChoice | undefined {
    return this.#continued;
  }

  /** The continuation's message was saved: the composer is back to this thread. */
  continuedSent(): void {
    this.#continued = undefined;
    this.#changed();
    this.#publish();
  }

  /** What the new thread's model reads, for checking the message's files against it. */
  continuedReader(): AttachmentReader | undefined {
    const choice = this.#continued;
    if (!choice) return undefined;
    return {
      provider: providerNames[choice.provider],
      imageInput: undefined,
      model: choice.model,
      modalities: selectionInputs(this.#read?.catalog.models ?? [], choiceSelection(choice)),
    };
  }

  /** A model or switch picked here, while the daemon hasn't reported it, for the composer. */
  next(): NextModel | undefined {
    const held = this.#continued ?? this.#chosen?.choice;
    if (held)
      return {
        provider: held.provider,
        model: this.#preview(held.model, 128),
        note: this.#continued ? continuationNote : switchNextTurnNote,
        continues: this.#continued !== undefined,
      };
    const thread = this.#store.thread;
    if (thread?.switch?.state !== "queued") return undefined;
    const selection = runsOn(thread);
    return (
      selection && {
        provider: selection.provider,
        model: "",
        note: switchNextTurnNote,
        continues: false,
      }
    );
  }

  /**
   * The thread changed: a switch sent from here gives way once the daemon reports any move, and
   * the rows are worked out again only when what they depend on moved.
   */
  threadChanged(): void {
    const stood = this.#stood();
    if (this.#chosen && this.#chosen.stood !== stood) {
      this.#chosen = undefined;
      this.#changed();
    }
    const shaped = JSON.stringify([stood, this.#busy()]);
    if (this.#state === "ready" && shaped !== this.#shaped) this.#publish();
  }

  async open(): Promise<void> {
    if (!this.#store.thread) return;
    if (this.#state !== "ready") this.#emit("loading");
    try {
      const [read, fork] = await Promise.all([
        readAgents(this.#client, this.#favorites, this.#now()),
        this.#readForkOnSwitch(),
      ]);
      this.#read = read;
      this.#forkOnSwitch = fork;
      this.#choices = modelChoices(read.catalog.models, read.agents.picker.accounts, this.#now());
      this.#state = "ready";
      this.#publish();
    } catch {
      if (this.#signal.aborted || this.#state === "ready") return;
      this.#emit("failed");
    }
  }

  async favorite(key: string): Promise<void> {
    if (!this.#read) return;
    try {
      const canonical = catalogModelIds(this.#read.catalog.models);
      this.#read.stars = await this.#favorites.toggle(key, canonical);
      this.#starProblem = null;
    } catch {
      this.#starProblem = "Couldn't save this favourite. Reconnect and try again.";
    }
    if (this.#state === "ready") this.#publish();
  }

  /**
   * The person picked `target` and pressed Done, having answered the row's question when it
   * asked one (`confirmed`). Refused when the row asks and wasn't confirmed.
   */
  pick(
    target: SwitchTarget,
    confirmed: boolean,
    requestId: string,
    send: Dispatch,
    admit: Admission,
  ): void {
    const scene = this.#scene();
    if (!scene) return admit(requestId, false, "Still reading this thread. Try again.");
    const plan = switchPlan(scene, target, this.#busy());
    switch (plan.kind) {
      case "stay":
        return admit(requestId, true, "");
      case "back":
        this.#continued = undefined;
        break;
      case "refused":
        return admit(requestId, false, plan.message);
      case "continue":
        if (!confirmed) return admit(requestId, false, unconfirmed);
        this.#continued = plan.choice;
        break;
      case "switch": {
        if (plan.ask && !confirmed) return admit(requestId, false, unconfirmed);
        const chosen = { choice: plan.choice, stood: this.#stood() };
        this.#continued = undefined;
        this.#chosen = chosen;
        send(switchPayload(this.#threadId, plan.choice), requestId, () => {
          if (this.#chosen !== chosen) return;
          this.#chosen = undefined;
          this.#changed();
          this.#publish();
        });
        this.#changed();
        this.#publish();
        return;
      }
    }
    admit(requestId, true, "");
    this.#changed();
    this.#publish();
  }

  #stood(): string {
    const thread = this.#store.thread;
    return JSON.stringify([
      selectionIdentity(runsOn(thread)),
      thread?.switch?.state ?? "",
      thread?.switch?.at ?? 0,
    ]);
  }
  #busy(): boolean {
    return isBusy(this.#store.thread?.status);
  }
  #scene(): SwitchScene | undefined {
    const thread = this.#store.thread;
    if (!thread || !this.#read) return undefined;
    return {
      thread,
      choices: this.#choices,
      forkOnSwitch: this.#forkOnSwitch,
      chosen: this.#chosen?.choice,
      continued: this.#continued,
    };
  }
  async #readForkOnSwitch(): Promise<boolean | undefined> {
    try {
      const reply = await this.#client.request(
        { type: "settings.get", key: "threads.forkOnSwitch", scope: { threadId: this.#threadId } },
        { signal: this.#signal, timeoutMs: 15_000 },
      );
      const value = SettingEntries.parse(reply).entries.find(
        (entry) => entry.key === "threads.forkOnSwitch",
      )?.value;
      return typeof value === "boolean" ? value : undefined;
    } catch {
      // Unread, the source is preserved: another provider or account continues in a new thread.
      return undefined;
    }
  }
  #emit(state: string): void {
    this.#state = state;
    this.#put("models", () => ({
      type: "thread.models",
      state,
      tabs: [],
      providers: [],
      favorites: [],
      starProblem: null,
      current: null,
      rows: {},
      asks: [],
    }));
  }
  #publish(): void {
    this.#shaped = JSON.stringify([this.#stood(), this.#busy()]);
    this.#put("models", () => {
      const scene = this.#scene();
      const read = this.#read;
      if (!scene || !read) return undefined;
      const picked = pickedChoice(scene);
      // A model the catalog doesn't list (retired, custom) is still the one checked, by name.
      const selection = runsOn(scene.thread);
      const current = picked
        ? { provider: picked.provider, key: picked.key, account: picked.accountId }
        : selection?.model
          ? {
              provider: selection.provider,
              key: modelKey(selection.provider, selection.model),
              account: selection.instanceId ?? "",
            }
          : undefined;
      const rows = pickerRows(read.agents, current, current?.provider, this.#preview, {
        keys: read.stars,
        problem: this.#starProblem,
      });
      const targets = rows.providers.flatMap((row) =>
        row.models.map((model) => ({ key: model.key, account: model.account })),
      );
      return {
        type: "thread.models",
        state: "ready",
        ...rows,
        current: current ?? null,
        currentLabel:
          picked || !selection?.model ? "" : this.#preview(modelLabel(selection.model), 128),
        ...switchRows(scene, targets, this.#busy()),
      };
    });
  }
}
