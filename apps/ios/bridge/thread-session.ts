import { retrySend, type ClientCore, type ThreadSource } from "@ace/client";
import {
  FollowUpBehavior,
  InteractionId,
  ModelListResult,
  ThreadId,
  type CommandPayload,
} from "@ace/protocol";
import { modelLabel } from "@ace/ui-core";
import { runsOn } from "@ace/ui-core/thread-execution";
import { z } from "zod";
import { dispatchCommand } from "./commands.ts";
import type { PatchPump } from "./patch-pump.ts";
import { preview } from "./presentation.ts";
import { followBlocks } from "./thread-blocks.ts";
import { QueueFollower } from "./thread-queue.ts";
import { answerResolution, controlsRow, sendPayload, stopPayload } from "./thread-controls.ts";

/*
 * What the open thread adds to the spike's item and interaction rows: its blocks, the composer's
 * controls, history paging and the model list, and the actions the thread screen sends. One
 * session per navigation generation; leaving the thread disposes it and cancels its reads.
 */

const requestId = z.string().min(1).max(64);
const ThreadAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    text: z.string().min(1),
    opposite: z.boolean(),
    requestId,
  }),
  z.object({ type: z.literal("stop"), requestId }),
  z.object({
    type: z.literal("answer"),
    interactionId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string().max(8192)).max(64)),
    dismissed: z.boolean(),
    requestId,
  }),
  z.object({ type: z.literal("retrySend"), id: z.string().min(1), requestId }),
  z.object({ type: z.literal("loadOlder") }),
  z.object({ type: z.literal("models") }),
  z.object({ type: z.literal("switchModel"), model: z.string().min(1).max(256), requestId }),
  z.object({
    type: z.literal("queue"),
    messageId: z.string().min(1).max(256),
    change: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("remove") }),
      z.object({ kind: z.literal("steer") }),
      z.object({ kind: z.literal("words"), text: z.string().min(1) }),
    ]),
    requestId,
  }),
]);
const SettingEntries = z.object({
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
});

export class ThreadSession {
  readonly #client: ClientCore;
  readonly #store: ThreadSource;
  readonly #threadId: ThreadId;
  readonly #epoch: number;
  readonly #pump: PatchPump;
  readonly #abort = new AbortController();
  readonly #stop: () => void;
  readonly #queue: QueueFollower;
  #setting: FollowUpBehavior | undefined;
  #loading = false;
  #models: { state: string; models: Record<string, unknown>[] } = { state: "idle", models: [] };

  constructor(
    client: ClientCore,
    store: ThreadSource,
    threadId: string,
    epoch: number,
    pump: PatchPump,
  ) {
    this.#client = client;
    this.#store = store;
    this.#threadId = ThreadId.parse(threadId);
    this.#epoch = epoch;
    this.#pump = pump;
    const blocks = followBlocks(store, (key, read) => this.#put(key, read));
    this.#queue = new QueueFollower(
      client,
      store,
      this.#threadId,
      this.#abort.signal,
      (key, read) => this.#put(key, read),
    );
    this.#stop = store.observe((keys) => {
      blocks(keys);
      if (keys === "all") void this.#readSetting();
      if (keys === "all" || keys.has("thread") || keys.has("interactions") || keys.has("cursor"))
        this.#controls();
      if (keys === "all" || keys.has("order") || keys.has("history")) this.#history();
      if (keys === "all" || keys.has("queue") || keys.has("thread") || keys.has("agents"))
        this.#queue.update();
    });
    blocks("all");
    this.#controls();
    this.#history();
    this.#queue.update();
    void this.#readSetting();
  }

  dispose(): void {
    this.#abort.abort();
    this.#stop();
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
        this.#dispatch(
          sendPayload(this.#store, this.#threadId, action.text, {
            opposite: action.opposite,
            setting: this.#setting,
          }),
          action.requestId,
        );
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
        this.#dispatch(
          resolution && {
            type: "interaction.resolve",
            interactionId: InteractionId.parse(action.interactionId),
            resolution,
          },
          action.requestId,
          "That answer doesn't fit the question. Check your choices.",
        );
        break;
      }
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
      case "queue":
        this.#dispatch(
          this.#queue.edit(action.messageId, action.change),
          action.requestId,
          "That queued message has changed. Check the queue and try again.",
        );
        break;
    }
  }

  #put(key: string, read: () => Record<string, unknown> | undefined): void {
    this.#pump.put(`thread:${key}`, () => {
      const patch = read();
      return patch && { ...patch, threadId: this.#threadId, epoch: this.#epoch };
    });
  }
  #admission(id: string, ok: boolean, message: string): void {
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
  #controls(): void {
    this.#put("controls", () => ({
      type: "thread.controls",
      row: controlsRow(this.#store, this.#setting),
    }));
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
      this.#controls();
    } catch {
      // Offline or refused: follow-ups queue until the daemon says otherwise.
    }
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
    this.#publishModels("loading", []);
    try {
      const reply = await this.#client.request(
        {
          type: "models.list",
          options: {
            provider: selection.provider,
            ...(selection.instanceId ? { instance: selection.instanceId } : {}),
            limit: 100,
          },
        },
        { signal: this.#abort.signal },
      );
      const listed = ModelListResult.parse(reply.result).models;
      const seen = new Set<string>();
      const models = listed.flatMap((model) => {
        if (seen.has(model.id)) return [];
        seen.add(model.id);
        return [
          {
            id: model.id,
            label: preview(model.displayName || modelLabel(model.id), 128),
            detail: preview(model.detail ?? "", 256),
            current: model.id === selection.model,
          },
        ];
      });
      this.#publishModels("ready", models);
    } catch {
      if (!this.#abort.signal.aborted) this.#publishModels("failed", []);
    }
  }
  #publishModels(state: string, models: Record<string, unknown>[]): void {
    this.#models = { state, models };
    this.#put("models", () => ({ type: "thread.models", ...this.#models }));
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
