import { retrySend, type ChangeTap, type ClientCore, type ThreadSource } from "@ace/client";
import {
  FollowUpBehavior,
  InteractionId,
  ThreadId,
  type CatalogModel,
  type CommandPayload,
} from "@ace/protocol";
import { catalogModelIds, composerReply, isBusy, messageHasContent, modelKey } from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";
import { z } from "zod";
import { host, scheduler } from "./host.ts";
import { dispatchCommand } from "./commands.ts";
import type { PatchPump } from "./patch-pump.ts";
import { preview } from "./presentation.ts";
import { questionDraft, ThreadAction, type QuestionReply } from "./thread-actions.ts";
import { AttachmentTray, nativeChunks, type ChunkReader } from "./thread-attachments.ts";
import { followBlocks } from "./thread-blocks.ts";
import { goalPayload, PillFollower } from "./thread-pill.ts";
import { QueueFollower } from "./thread-queue.ts";
import { requestResolution } from "./thread-requests.ts";
import { StepsFollower } from "./thread-steps.ts";
import { ModelFavorites } from "./model-favorites.ts";
import { ThreadAccessFollower } from "./thread-access.ts";
import { threadModelRows, type ThreadModelRow } from "./thread-models.ts";
import { TuneFollower } from "./thread-tune.ts";
import { answerResolution, controlsRow, sendPayload, stopPayload } from "./thread-controls.ts";

/*
 * What the open thread adds to the spike's item and interaction rows: its blocks, the composer's
 * controls (effort, speed, attachments), history paging, the model list, finished turns' steps
 * and a subagent's lane, and the actions the thread screen sends. One session per navigation
 * generation; leaving the thread disposes it and cancels its reads.
 */

const SettingEntries = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
});
type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;

export class ThreadSession {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #epoch: number;
  readonly #pump: PatchPump;
  readonly #abort = new AbortController();
  readonly #stop: () => void;
  readonly #queue: QueueFollower;
  readonly #blocks: ReturnType<typeof followBlocks>;
  readonly #pill: PillFollower;
  readonly #steps: StepsFollower;
  readonly #tune: TuneFollower;
  readonly #tray: AttachmentTray;
  #lane: { agentId: string; tap: ChangeTap } | undefined;
  #setting: FollowUpBehavior | undefined;
  /**
   * Whether the thread's follow-up setting has been read (or given up on). Until then the composer
   * gets no controls and a send waits, so neither offers nor sends a delivery the setting changes.
   */
  #settingKnown = false;
  #known: () => void = () => {};
  readonly #whenKnown = new Promise<void>((resolve) => {
    this.#known = resolve;
  });
  #loading = false;
  #models: { state: string; models: ThreadModelRow[] } = { state: "idle", models: [] };
  #listed: CatalogModel[] = [];
  #stars: string[] = [];
  #starProblem: string | null = null;
  readonly #favorites: ModelFavorites;
  readonly #access: ThreadAccessFollower;

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: string,
    epoch: number,
    pump: PatchPump,
    chunks: ChunkReader = nativeChunks,
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = ThreadId.parse(threadId);
    this.#epoch = epoch;
    this.#pump = pump;
    const put: Put = (key, read) => this.#put(key, read);
    const signal = this.#abort.signal;
    this.#blocks = followBlocks(store, put);
    this.#pill = new PillFollower(store, put);
    this.#queue = new QueueFollower(client, store, this.#threadId, signal, put, (count) =>
      this.#pill.queued(count),
    );
    this.#steps = new StepsFollower(client, store, this.#threadId, put);
    this.#favorites = new ModelFavorites(client);
    this.#access = new ThreadAccessFollower(client, store, this.#threadId, put, (payload, id) =>
      this.#dispatch(payload, id),
    );
    this.#tune = new TuneFollower(client, store, signal, put, () => host.now());
    this.#tray = new AttachmentTray(
      client,
      { threadId: this.#threadId },
      signal,
      (files) => put("attachments", () => ({ type: "thread.attachments", files })),
      chunks,
    );
    this.#stop = store.observe((keys) => {
      this.#blocks.tap(keys);
      this.#pill.tap(keys);
      this.#lane?.tap(keys);
      this.#steps.changed(keys);
      if (keys === "all") void this.#readSetting();
      if (
        keys === "all" ||
        keys.has("thread") ||
        keys.has("interactions") ||
        keys.has("cursor") ||
        // A subagent starting or ending moves how a message goes (in now while the root only waits).
        keys.has("agents") ||
        [...keys].some((key) => key.startsWith("agent:"))
      )
        this.#controls();
      if (keys === "all" || keys.has("thread")) {
        this.#tune.update();
        this.#access.update();
      }
      if (keys === "all" || keys.has("order") || keys.has("history")) this.#history();
      if (keys === "all" || keys.has("queue") || keys.has("thread") || keys.has("agents"))
        this.#queue.update();
      if (keys === "all") this.#ready();
    });
    this.#blocks.tap("all");
    this.#pill.tap("all");
    this.#controls();
    this.#history();
    this.#queue.update();
    this.#tune.update();
    this.#access.update();
    this.#ready();
    void this.#readSetting();
    // Offline, the read waits for the connection; the composer must not wait with it.
    const cancel = scheduler.set(1000, () => this.#knowSetting());
    this.#abort.signal.addEventListener("abort", cancel, { once: true });
  }

  // Queued after the snapshot's items AND blocks, so native reveals one coherent transcript: the
  // latest window, never waiting for older history (`thread-history.ts`).
  #ready(): void {
    if (this.#store.thread)
      this.#put("ready", () => ({ type: "thread.ready", count: this.#store.order.length }));
  }

  /** The navigation generation this session serves. */
  get epoch(): number {
    return this.#epoch;
  }

  dispose(): void {
    this.#abort.abort();
    this.#stop();
    this.#steps.dispose();
    this.#tray.dispose();
  }

  handle(raw: unknown): void {
    const parsed = ThreadAction.safeParse(raw);
    if (!parsed.success) {
      this.#pump.put("error", () => ({ type: "error", message: "That action isn't supported." }));
      return;
    }
    const action = parsed.data;
    switch (action.type) {
      case "send":
        if (!this.#reply(action.text, action.reply, action.requestId))
          this.#send(action.text, action.opposite, action.requestId);
        break;
      case "stop":
        this.#dispatch(stopPayload(this.#store, this.#threadId), action.requestId);
        break;
      case "answer": {
        const resolution = answerResolution(
          this.#store.interaction(action.interactionId),
          action.answers,
          action.dismissed,
        );
        this.#resolve(
          action.interactionId,
          resolution,
          action.requestId,
          "That answer doesn't fit the question. Check your choices.",
        );
        break;
      }
      case "resolve":
        this.#resolve(
          action.interactionId,
          requestResolution(this.#store.interaction(action.interactionId), action.answer),
          action.requestId,
          "That doesn't fit the request. Check what you entered.",
        );
        break;
      case "effort":
        this.#admission(
          action.requestId,
          this.#tune.effort(action.effort ?? undefined),
          "That effort can't be set for this model.",
        );
        break;
      case "speed":
        this.#admission(
          action.requestId,
          this.#tune.speed(action.speed),
          "That speed can't be set for this model.",
        );
        break;
      case "retrySend":
        void this.#retry(action.id, action.requestId);
        break;
      case "loadOlder":
        void this.#loadOlder();
        break;
      case "models":
        void this.#listModels();
        break;
      case "switchModel":
        this.#dispatch(this.#switchPayload(action.model), action.requestId);
        break;
      case "access":
        this.#access.set(action.mode, action.requestId);
        break;
      case "favorite":
        void this.#favorite(action.model);
        break;
      case "queue":
        this.#dispatch(
          this.#queue.edit(action.messageId, action.change),
          action.requestId,
          "That queued message has changed. Check the queue and try again.",
        );
        break;
      case "goal":
        this.#dispatch(
          goalPayload(this.#threadId, this.#store.thread?.goal, this.#pill.editable, action.change),
          action.requestId,
          "That goal has changed. Check it and try again.",
        );
        break;
      case "steps.open":
        this.#steps.open(action.ordinal, this.#answersOf(action.block));
        break;
      case "steps.close":
        this.#steps.close(action.ordinal);
        break;
      case "steps.more":
        this.#steps.more(action.ordinal);
        break;
      case "lane.open":
        this.#openLane(action.agentId);
        break;
      case "lane.close":
        this.#lane = undefined;
        break;
      case "attach":
        this.#tray.attach(action.file, this.#tune.reader());
        break;
      case "detach":
        this.#tray.detach(action.localId);
        break;
    }
  }

  #put(key: string, read: () => Record<string, unknown> | undefined): void {
    this.#pump.put(`thread:${key}`, () => {
      const patch = read();
      return patch && { ...patch, threadId: this.#threadId, epoch: this.#epoch };
    });
  }
  #admission(id: string, ok: boolean, refused: string): void {
    const message = ok ? "" : refused;
    this.#pump.put(`admission:${id}`, () => ({ type: "admission", id, ok, message }));
  }
  #dispatch(
    payload: CommandPayload | undefined,
    id: string,
    refused = "That can't be done right now.",
  ): void {
    if (!payload) this.#admission(id, false, refused);
    else void dispatchCommand(this.#client, payload, id, this.#pump);
  }
  #resolve(
    interactionId: string,
    resolution: Extract<CommandPayload, { type: "interaction.resolve" }>["resolution"] | undefined,
    id: string,
    refused: string,
  ): void {
    this.#dispatch(
      resolution && {
        type: "interaction.resolve",
        interactionId: InteractionId.parse(interactionId),
        resolution,
      },
      id,
      refused,
    );
  }
  /**
   * Words sent while the agent waits on its question answer it, when they can (the shared
   * `composerReply`): the picks on its card stay. Otherwise they go as a message.
   */
  #reply(text: string, reply: QuestionReply | undefined, id: string): boolean {
    if (!reply) return false;
    const resolution = composerReply(
      this.#store.interaction(reply.interactionId),
      questionDraft(reply),
      text,
    );
    if (!resolution) return false;
    this.#resolve(reply.interactionId, resolution, id, "That answer doesn't fit the question.");
    return true;
  }
  /** A message as the composer showed it: its delivery, the picked effort and speed, its files. */
  #send(text: string, opposite: boolean, id: string): void {
    if (!this.#settingKnown) {
      void this.#whenKnown.then(() => this.#send(text, opposite, id));
      return;
    }
    if (!messageHasContent(text, this.#tray.size)) {
      this.#admission(id, false, "Write a message or attach a file.");
      return;
    }
    const files = this.#tray.context();
    if ("refused" in files) {
      this.#admission(id, false, files.refused);
      return;
    }
    const payload = sendPayload(this.#store, this.#threadId, text, {
      opposite,
      setting: this.#setting,
    });
    if (payload.type !== "thread.send") return;
    const { options, spends } = this.#tune.sendOptions(
      isBusy(this.#store.thread?.status),
      payload.delivery,
    );
    const message: CommandPayload = {
      ...payload,
      ...(options ? { options } : {}),
      ...(files.context ? { context: files.context } : {}),
    };
    void dispatchCommand(this.#client, message, id, this.#pump, {
      saved: () => this.#tray.sent(),
      receipt: (ok) => {
        if (ok && spends) this.#tune.spent(spends);
      },
    });
  }
  /** A settled head's answers, which its opened log leaves out. */
  #answersOf(key: string): readonly string[] {
    const block = this.#blocks.block(key);
    return block?.kind === "work" ? (block.answerIds ?? []) : [];
  }
  /** One native subagent's own blocks, grouped as the transcript is, for its lane sheet. */
  #openLane(agentId: string): void {
    if (this.#lane?.agentId === agentId) return;
    const lane = followBlocks(this.#store, (key, read) => this.#put(key, read), { agentId });
    this.#lane = { agentId, tap: lane.tap };
    lane.tap("all");
  }
  #controls(): void {
    this.#put("controls", () =>
      this.#settingKnown
        ? { type: "thread.controls", row: controlsRow(this.#store, this.#setting) }
        : undefined,
    );
  }
  #history(): void {
    this.#put("history", () => ({
      type: "thread.history",
      hasOlder: this.#store.itemsBefore != null,
      loading: this.#loading,
    }));
  }
  async #readSetting(): Promise<void> {
    try {
      const reply = await this.#client.request(
        {
          type: "settings.get",
          key: "threads.followUpBehavior",
          scope: { threadId: this.#threadId },
        },
        { signal: this.#abort.signal },
      );
      const entry = SettingEntries.parse(reply).entries.find(
        (candidate) => candidate.key === "threads.followUpBehavior",
      );
      const value = FollowUpBehavior.safeParse(entry?.value);
      this.#setting = value.success ? value.data : undefined;
    } catch {
      // Offline or refused: the shared default applies until the daemon says otherwise.
    }
    this.#knowSetting();
  }
  #knowSetting(): void {
    if (this.#abort.signal.aborted) return;
    this.#settingKnown = true;
    this.#known();
    this.#controls();
  }
  async #loadOlder(): Promise<void> {
    if (this.#loading || this.#store.itemsBefore == null) return;
    this.#loading = true;
    this.#history();
    try {
      await this.#client.loadOlder(this.#threadId, 200, { signal: this.#abort.signal });
    } catch {
      if (!this.#abort.signal.aborted)
        this.#pump.put("error", () => ({
          type: "error",
          message: "Couldn't load earlier messages. Check your connection.",
        }));
    } finally {
      this.#loading = false;
      if (!this.#abort.signal.aborted) this.#history();
    }
  }
  async #retry(commandId: string, id: string): Promise<void> {
    const pending = this.#client.pendingSend(commandId);
    if (pending?.state !== "failed") {
      this.#admission(id, false, "That message isn't waiting for a retry.");
      return;
    }
    try {
      await retrySend(this.#client, commandId, pending.payload);
      this.#admission(id, true, "");
    } catch {
      this.#admission(id, false, "Couldn't send it again. It is still here.");
    }
  }
  #selection() {
    return runsOn(this.#store.thread);
  }
  async #listModels(): Promise<void> {
    const selection = this.#selection();
    if (!selection) return;
    this.#publishModels("loading");
    try {
      this.#listed = await this.#tune.read();
      this.#stars = await this.#favorites.read(catalogModelIds(this.#listed));
      this.#publishModels("ready");
    } catch {
      if (!this.#abort.signal.aborted) this.#publishModels("failed");
    }
  }
  async #favorite(model: string): Promise<void> {
    const selection = this.#selection();
    if (!selection) return;
    try {
      const key = modelKey(selection.provider, model);
      this.#stars = await this.#favorites.toggle(key, catalogModelIds(this.#listed));
      this.#starProblem = null;
    } catch {
      this.#starProblem = "Couldn't save this favourite. Reconnect and try again.";
    }
    if (this.#models.state === "ready") this.#publishModels("ready");
  }
  #publishModels(state: string): void {
    const selection = this.#selection();
    const rows =
      state === "ready" && selection
        ? threadModelRows(this.#listed, selection, this.#stars, preview)
        : { models: [], favorites: [] };
    this.#models = { state, models: rows.models };
    const patch = {
      type: "thread.models",
      ...this.#models,
      favorites: rows.favorites,
      starProblem: this.#starProblem,
    };
    this.#put("models", () => patch);
  }
  #switchPayload(model: string): CommandPayload | undefined {
    const selection = this.#selection();
    const offered = this.#models.models.some((entry) => entry.id === model);
    if (!selection || !offered) return undefined;
    return {
      type: "thread.switch",
      threadId: this.#threadId,
      selection: {
        provider: selection.provider,
        model,
        ...(selection.instanceId ? { instanceId: selection.instanceId } : {}),
      },
    };
  }
}
