import { retrySend, type ChangeTap, type ClientCore, type ThreadSource } from "@ace/client";
import {
  FollowUpBehavior,
  InteractionId,
  ThreadId,
  type CatalogEntry,
  type CommandPayload,
} from "@ace/protocol";
import { composerReply, isBusy, messageHasContent } from "@ace/ui-core";
import { subagentRetryMessage } from "@ace/ui-core/mobile";
import { z } from "zod";
import { host, scheduler } from "./host.ts";
import { dispatchCommand } from "./commands.ts";
import { goalCommand, joinContext, messageContent, type Reference } from "./composer-references.ts";
import type { PatchPump } from "./patch-pump.ts";
import { preview } from "./presentation.ts";
import { questionDraft, ThreadAction, type QuestionReply } from "./thread-actions.ts";
import { AttachmentTray, nativeChunks, type ChunkReader } from "./thread-attachments.ts";
import { followBlocks } from "./thread-blocks.ts";
import { followLaneInfo } from "./lane-info.ts";
import { goalPayload, PillFollower } from "./thread-pill.ts";
import { QueueFollower } from "./thread-queue.ts";
import { requestResolution } from "./thread-requests.ts";
import { StepsFollower } from "./thread-steps.ts";
import { ThreadAccessFollower } from "./thread-access.ts";
import { continuationPayload } from "./thread-continue.ts";
import { ThreadModelSheet } from "./thread-model-sheet.ts";
import { TuneFollower } from "./thread-tune.ts";
import { answerResolution, controlsRow, sendPayload, stopPayload } from "./thread-controls.ts";

/*
 * What the open thread adds to the spike's item and interaction rows: its blocks, the composer's
 * controls (effort, speed, attachments), whether older history exists, the model list, finished turns' steps
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
  #lane: { agentId: string; tap: ChangeTap; info: ChangeTap } | undefined;
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
  readonly #sheet: ThreadModelSheet;
  readonly #access: ThreadAccessFollower;
  /** The thread's catalog as the composer last read it, for a typed `/name`. */
  readonly #catalog: (threadId: string) => readonly CatalogEntry[] | undefined;

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: string,
    epoch: number,
    pump: PatchPump,
    chunks: ChunkReader = nativeChunks,
    catalog: (threadId: string) => readonly CatalogEntry[] | undefined = () => undefined,
  ) {
    this.#catalog = catalog;
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
    this.#sheet = new ThreadModelSheet(client, store, this.#threadId, signal, {
      put,
      now: () => host.now(),
      preview,
      changed: () => this.#controls(),
      files: () => this.#tray.files(),
    });
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
      this.#lane?.info(keys);
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
        this.#sheet.threadChanged();
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
  // latest window, never waiting for older history (the reading window, `native-transcript.ts`).
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
        if ((action.continues ?? false) !== (this.#sheet.continued !== undefined))
          this.#admission(
            action.requestId,
            false,
            "Where this message goes just changed. Check the model and send again.",
          );
        else if (this.#sheet.continued) this.#continue(action.text, action.requestId);
        // `/goal` goes first, as the web's composer checks it: a pending question never takes it.
        else if (this.#goal(action.text, action.references ?? [], action.requestId)) break;
        else if (!this.#reply(action.text, action.reply, action.requestId))
          this.#send(action.text, action.opposite, action.requestId, action.references ?? []);
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
      case "models":
        void this.#sheet.open();
        break;
      case "switchModel":
        this.#sheet.pick(
          { key: action.key, account: action.account },
          action.confirmed,
          action.requestId,
          (payload, id, refused) =>
            void dispatchCommand(this.#client, payload, id, this.#pump, {
              unsaved: refused,
              receipt: (result) => {
                if (!result.ok) refused();
              },
            }),
          (id, ok, message) => this.#admission(id, ok, message),
        );
        break;
      case "access":
        this.#access.set(action.mode, action.requestId);
        break;
      case "favorite":
        void this.#sheet.favorite(action.key);
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
        if (!action.agentId || this.#lane?.agentId === action.agentId) this.#closeLane();
        break;
      case "lane.retry":
        this.#retryLane(action.agentId, action.requestId);
        break;
      case "attach":
        this.#tray.attach(action.file);
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
  /** `/goal <objective>` sets the provider's own goal; true when it did (or was refused). */
  #goal(text: string, references: readonly Reference[], id: string): boolean {
    const content = messageContent(text, references, this.#catalog(this.#threadId));
    const goal = goalCommand(
      this.#threadId,
      this.#store.thread,
      text,
      this.#tray.size > 0 || content.references !== undefined,
    );
    if (goal) this.#dispatch(goal, id, "This thread's goal can't be changed right now.");
    return goal !== undefined;
  }
  /** A message as the composer showed it: its delivery, the picked effort and speed, its files. */
  #send(text: string, opposite: boolean, id: string, references: readonly Reference[]): void {
    if (!this.#settingKnown) {
      void this.#whenKnown.then(() => this.#send(text, opposite, id, references));
      return;
    }
    const content = messageContent(text, references, this.#catalog(this.#threadId));
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
    const context = joinContext(files.context, content.references);
    const message: CommandPayload = {
      ...payload,
      input: content.input,
      ...(options ? { options } : {}),
      ...(context ? { context } : {}),
    };
    void dispatchCommand(this.#client, message, id, this.#pump, {
      saved: () => this.#tray.sent(),
      receipt: ({ ok }) => {
        if (ok && spends) this.#tune.spent(spends);
      },
    });
  }
  /**
   * The message starts a new thread on the model picked to continue on (`thread.fork`), and the
   * app opens it once the daemon names it (`thread.continued`).
   */
  #continue(text: string, id: string): void {
    const choice = this.#sheet.continued;
    if (!choice) return;
    if (this.#sheet.sending) {
      this.#admission(id, false, "Still starting the new thread. Wait for it to open.");
      return;
    }
    const files = this.#tray.context();
    const built =
      "refused" in files
        ? files
        : continuationPayload({
            reader: this.#store,
            threadId: this.#threadId,
            choice,
            text,
            files: this.#tray.files(),
            modalities: this.#sheet.modalities(choice),
            context: files.context,
          });
    if ("refused" in built) {
      this.#admission(id, false, built.refused);
      return;
    }
    // Swift keeps the words and files until the daemon answers; only a started thread takes them.
    this.#sheet.continuationSending();
    void dispatchCommand(this.#client, built.payload, id, this.#pump, {
      unsaved: () => this.#sheet.continuationSettled(false),
      refusal: (error) => `The new thread didn't start: ${error ?? "your computer refused it"}.`,
      receipt: (result) => {
        this.#sheet.continuationSettled(result.ok);
        if (!result.ok) return;
        this.#tray.sent();
        const threadId = result.forkThreadId;
        if (threadId)
          this.#put("continued", () => ({ type: "thread.continued", id, opened: threadId }));
      },
    });
  }
  /** A settled head's answers, which its opened log leaves out. */
  #answersOf(key: string): readonly string[] {
    const block = this.#blocks.block(key);
    return block?.kind === "work" ? (block.answerIds ?? []) : [];
  }
  /**
   * One native subagent's own blocks, grouped as the transcript is, and what it is (its prompt,
   * branch state, requests and controls), for its lane view.
   */
  #openLane(agentId: string): void {
    if (this.#lane?.agentId === agentId) return;
    this.#closeLane();
    const put: Put = (key, read) => this.#put(key, read);
    const lane = followBlocks(this.#store, put, { agentId });
    const info = followLaneInfo(this.#store, agentId, put, () => host.now());
    this.#lane = { agentId, tap: lane.tap, info };
    lane.tap("all");
  }
  #closeLane(): void {
    if (!this.#lane) return;
    this.#lane = undefined;
  }
  /**
   * The thread's main agent is sent a short message naming the subagent, its task and how it
   * ended, so it can relaunch it: queued while it works, a new turn while it is idle. Refused
   * when the subagent can't be retried now (still going, ended well, or a read-only thread).
   */
  #retryLane(agentId: string, id: string): void {
    const text = subagentRetryMessage(this.#store, agentId, host.now());
    this.#dispatch(
      text === undefined
        ? undefined
        : {
            type: "thread.send",
            threadId: this.#threadId,
            input: [{ type: "text", text }],
            trigger: "user",
            delivery: "queue",
          },
      id,
      "That subagent can't be retried now. Check its state.",
    );
  }
  #controls(): void {
    this.#put("controls", () =>
      this.#settingKnown
        ? {
            type: "thread.controls",
            row: controlsRow(this.#store, this.#setting, this.#sheet.next()),
          }
        : undefined,
    );
  }
  #history(): void {
    this.#put("history", () => ({
      type: "thread.history",
      hasOlder: this.#store.itemsBefore != null,
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
}
