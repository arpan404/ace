import type { ClientCore, ThreadSource } from "@ace/client";
import {
  ModelListResult,
  type CatalogModel,
  type FollowUpBehavior,
  type TurnOptions,
} from "@ace/protocol";
import {
  currentModelChoice,
  effortLabel,
  followUpTurnOptions,
  modelChoices,
  optionEffort,
  pickEffort,
  pickSpeed,
  providerNames,
  reconcileNextOptions,
  recordedChoice,
  speedLabel,
  threadTuning,
  type AttachmentReader,
  type ModelChoice,
  type Speed,
} from "@ace/ui-core";
import { runsOn, selectionIdentity, type PendingTurn } from "@ace/ui-core/thread-execution";
import { preview } from "./presentation.ts";

/*
 * Effort and speed for the open thread's next message, as the web's model control offers them:
 * the levels and speeds the catalog lists for what the thread runs on, allowed only where its
 * provider takes them as session options. A pick waits here and goes out with the next message
 * (`thread.send` options, the shared `followUpTurnOptions`); it is spent once the daemon accepts
 * that message, and checked again if the thread moves to another model before then.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

export class TuneFollower {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #signal: AbortSignal;
  readonly #put: Put;
  readonly #now: () => number;
  #catalog: CatalogModel[] = [];
  #choices: ModelChoice[] = [];
  #provider: string | undefined;
  #pending: PendingTurn | undefined;
  #notice = "";

  constructor(
    client: ClientCore,
    store: ThreadSource,
    signal: AbortSignal,
    put: Put,
    now: () => number,
  ) {
    this.#client = client;
    this.#store = store;
    this.#signal = signal;
    this.#put = put;
    this.#now = now;
  }

  /** The thread changed: read the catalog for a new provider, re-check a pick, redraw. */
  update(): void {
    const selection = runsOn(this.#store.thread);
    if (selection && selection.provider !== this.#provider) void this.read().catch(() => {});
    this.#reconcile();
    this.#emit();
  }

  /** The thread's provider's models (`models.list`), kept for the controls. */
  async read(): Promise<CatalogModel[]> {
    const selection = runsOn(this.#store.thread);
    if (!selection) return [];
    this.#provider = selection.provider;
    const reply = await this.#client.request(
      {
        type: "models.list",
        options: {
          provider: selection.provider,
          ...(selection.instanceId ? { instance: selection.instanceId } : {}),
          limit: 100,
        },
      },
      { signal: this.#signal },
    );
    this.#catalog = ModelListResult.parse(reply.result).models;
    this.#choices = modelChoices(this.#catalog, [], this.#now());
    this.#reconcile();
    this.#emit();
    return this.#catalog;
  }

  effort(effort: string | undefined): boolean {
    const tuning = this.#tuning();
    if (tuning.effort.reason !== undefined) return false;
    if (effort !== undefined && !tuning.effort.efforts.includes(effort)) return false;
    this.#pick(pickEffort(tuning, effort));
    return true;
  }

  speed(speed: Speed): boolean {
    const tuning = this.#tuning();
    if (tuning.speed.reason !== undefined) return false;
    if (!tuning.speed.tiers.some((tier) => tier.speed === speed)) return false;
    this.#pick(pickSpeed(tuning, speed));
    return true;
  }

  /** What a message sent now carries, and the pick it spends once accepted. */
  sendOptions(
    busy: boolean,
    delivery: FollowUpBehavior | undefined,
  ): { options: TurnOptions | undefined; spends: PendingTurn | undefined } {
    const thread = this.#store.thread;
    const options = followUpTurnOptions({
      thread,
      choice: this.#current(),
      pending: this.#pending,
      busy,
      delivery,
    });
    const fits = this.#pending?.identity === selectionIdentity(runsOn(thread));
    return { options, spends: fits ? this.#pending : undefined };
  }

  /** The daemon accepted the message carrying `pick`: it is spent, unless picked again since. */
  spent(pick: PendingTurn): void {
    if (this.#pending !== pick) return;
    this.#pending = undefined;
    this.#emit();
  }

  /** What the agent can read, for checking an attachment before it uploads. */
  reader(): AttachmentReader | undefined {
    const thread = this.#store.thread;
    const selection = runsOn(thread);
    if (!thread || !selection) return undefined;
    const choice = this.#current();
    const model = this.#catalog.find(
      (entry) => entry.provider === choice?.provider && entry.id === choice?.modelId,
    );
    return {
      provider: providerNames[selection.provider],
      imageInput: thread.capabilities?.imageInput,
      model: choice?.model,
      modalities: model?.inputModalities,
    };
  }

  #current(): ModelChoice | undefined {
    return currentModelChoice(this.#choices, runsOn(this.#store.thread));
  }
  #shown(): ModelChoice | undefined {
    return this.#current() ?? recordedChoice(runsOn(this.#store.thread));
  }
  #tuning() {
    const identity = selectionIdentity(runsOn(this.#store.thread));
    const pending = this.#pending?.identity === identity ? this.#pending.options : undefined;
    return threadTuning({ thread: this.#store.thread, choice: this.#shown(), pending });
  }
  #pick(options: PendingTurn["options"] | undefined): void {
    const identity = selectionIdentity(runsOn(this.#store.thread));
    this.#pending = options && { identity, options };
    this.#notice = "";
    this.#emit();
  }
  /** The thread moved since the pick: keep what its model still takes, and say what went. */
  #reconcile(): void {
    const pending = this.#pending;
    const identity = selectionIdentity(runsOn(this.#store.thread));
    const shown = this.#current();
    if (!pending || pending.identity === identity || !shown) return;
    const tuning = threadTuning({ thread: this.#store.thread, choice: shown, pending: undefined });
    const { options, dropped } = reconcileNextOptions({
      base: tuning.base,
      pending: pending.options,
      efforts: shown.efforts,
      effortAllowed: tuning.effort.reason === undefined,
      speeds: shown.speeds,
      speedAllowed: tuning.speed.reason === undefined,
    });
    this.#pending = options && { identity, options };
    if (dropped.length)
      this.#notice = preview(
        `${dropped.includes("effort") ? "Effort" : "Speed"}${dropped.length > 1 ? " and speed" : ""} reset for ${shown.model}`,
        256,
      );
  }
  #emit(): void {
    this.#put("tune", () => {
      const tuning = this.#tuning();
      const { effort, speed, preset, options } = tuning;
      const picked = optionEffort(options);
      return {
        type: "thread.tune",
        efforts: effort.efforts
          .slice(0, 16)
          .map((id) => ({ id, label: preview(effortLabel(id), 64) })),
        effort: effort.current ?? "",
        effortDefault: !effort.reported,
        effortReason: preview(effort.reason ?? "", 256),
        speeds:
          speed.tiers.length > 1
            ? speed.tiers.map((tier) => ({ speed: tier.speed, label: speedLabel(tier.speed) }))
            : [],
        speed: speed.speed,
        speedReason: preview(speed.reason ?? "", 256),
        pending:
          this.#pending !== undefined &&
          this.#pending.identity === selectionIdentity(runsOn(this.#store.thread)),
        canReset: picked !== undefined && picked !== preset,
        notice: this.#notice,
      };
    });
  }
}
