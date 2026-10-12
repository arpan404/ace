import {
  CliTree,
  ThreadId,
  InteractionId,
  ProviderKind,
  CommandPayload,
  type Item,
  type Interaction,
} from "@ace/protocol";
import { ClientError, type ThreadSubscription } from "@ace/client";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { connectChat, waitSelection } from "./connection.ts";
import { selectedProfile } from "./profiles.ts";
import { ensureDaemon, systemOpenRuntime } from "./open-runtime.ts";
import { key, command } from "./mutations.ts";
import { admitWork, runThreadId } from "./work.ts";
import { remoteWorkProject } from "./projects.ts";
import { approval } from "./approval.ts";
import { CliFailure, treeOutcome } from "./output.ts";
import { chatAction } from "./chat-input.ts";
import { chatIO, type ChatIO } from "./chat-io.ts";
import type { ChatRecord } from "./chat-render.ts";

export async function chatCommand(
  args: Args,
  config: Config,
  makeIO: (args: Args, signal: AbortSignal) => ChatIO = chatIO,
) {
  validateArgs(args, ["project", "provider", "thread", "model", "idempotency-key", "stream"], 1);
  if (args.flags.stream && args.flags.stream !== "jsonl")
    throw new CliFailure("refused", "Chat streams use jsonl");
  if (!selectedProfile(config.dataDir, option(args, "remote")))
    await ensureDaemon(config.dataDir, args, systemOpenRuntime());
  const session = await connectChat(config.dataDir, args);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([session.signal, lifetime.signal]);
  const io = makeIO(args, signal);
  let threadId = option(args, "thread");
  let model = option(args, "model");
  let root: ThreadSubscription | undefined;
  let attention: { id: string; lease: ThreadSubscription } | undefined;
  let lastMutation: { threadId: string | undefined; idempotencyKey: string } | undefined;
  let admitting = false;
  let attaching = false;
  let quitRequested = false;
  let failure: unknown;
  let queuedBytes = 0;
  let output = Promise.resolve();
  const shown = new Set<string>();
  const emit = (record: ChatRecord) => {
    const bytes = Buffer.byteLength(JSON.stringify(record));
    queuedBytes += bytes;
    if (queuedBytes > 1048576) {
      failure = new CliFailure("uncertain", "Chat output consumer is too slow", lastMutation);
      lifetime.abort();
      return;
    }
    output = output
      .then(() => io.write(record))
      .catch(() => {
        failure = new CliFailure(
          "uncertain",
          "Chat output failed. Use the last idempotency key to check or retry.",
          lastMutation,
        );
        lifetime.abort();
      })
      .finally(() => {
        queuedBytes -= bytes;
      });
  };
  const showItem = (item: Item) => {
    if (item.type === "message")
      emit({
        type: "message",
        id: item.id,
        role: item.role,
        text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        complete: item.complete,
        preview: item.parts.some((part) => part.type === "text" && !!part.source),
      });
    else if (item.complete) emit({ type: "item", item });
  };
  const showInteraction = (interaction: Interaction) => {
    if (shown.has(interaction.id)) return;
    shown.add(interaction.id);
    if (shown.size > 256) {
      const oldest = shown.values().next().value;
      if (oldest !== undefined) shown.delete(oldest);
    }
    emit({ type: "interaction", interaction });
  };
  const stopMessages = session.client.onMessage((message) => {
    const observed =
      message.type === "snapshot" && message.view.kind === "thread"
        ? message.view.thread.id
        : undefined;
    if (observed === threadId && message.type === "snapshot" && message.view.kind === "thread")
      for (const id of message.view.itemOrder) {
        const item = message.view.items[id];
        if (item) showItem(item);
      }
    if (message.type !== "events") return;
    for (const event of message.events) {
      if (event.threadId === threadId) {
        const payload = event.payload;
        if (payload.type === "item.created" || payload.type === "item.updated")
          showItem(payload.item);
        if (payload.type === "item.delta" && payload.field === "text")
          emit({ type: "delta", id: payload.itemId, text: payload.append });
      }
      if (
        (event.threadId === threadId || event.threadId === attention?.id) &&
        event.payload.type === "interaction.opened"
      )
        showInteraction(event.payload.interaction);
    }
  });
  const interactions = (): Interaction[] =>
    [root, attention?.lease].flatMap((lease) =>
      lease
        ? lease.store.interactionIds().flatMap((id) => {
            const value = lease.store.interaction(id);
            return value?.state === "pending" ? [value] : [];
          })
        : [],
    );
  const showInteractions = () => {
    for (const interaction of interactions()) showInteraction(interaction);
  };
  const attach = async (id: string, idempotencyKey?: string) => {
    root?.release();
    root = session.client.thread(id);
    attaching = true;
    cancelObservation();
    try {
      await waitSelection(
        root.store.select(["thread", "error"], (reader) => ({
          loaded: !!reader.thread,
          error: reader.error,
        })),
        (value) => value.loaded || !!value.error,
        signal,
      );
    } finally {
      attaching = false;
    }
    if (root.store.error) throw root.store.error;
    const selected = option(args, "provider");
    if (selected && root.store.thread?.provider !== selected)
      throw new CliFailure(
        "refused",
        `This thread uses ${root.store.thread?.provider}. Select that provider or omit --provider.`,
      );
    emit({ type: "thread", threadId: id, ...(idempotencyKey ? { idempotencyKey } : {}) });
    showInteractions();
  };
  let previousStatus = "";
  const observe = async () => {
    while (!signal.aborted) {
      try {
        if (threadId && root && session.client.state === "ready") {
          const response = await session.client.request(
            {
              type: "cli.request",
              operation: { op: "thread.tree", threadId: ThreadId.parse(threadId) },
            },
            { signal },
          );
          if (!response.result.ok) throw new CliFailure("uncertain", "Tree facts unavailable");
          if (session.client.state !== "ready")
            throw new CliFailure("uncertain", "Connection changed during tree observation");
          const tree = CliTree.parse(response.result.data);
          const status = treeOutcome(tree) ?? "in_progress";
          const working = tree.some((member) => member.status.state === "working");
          const signature = `${status}:${working}`;
          if (signature !== previousStatus) {
            previousStatus = signature;
            emit({ type: "status", status, working, threadId });
          }
          const child = tree.find(
            (member) => member.threadId !== threadId && member.status.state === "needs_you",
          );
          if (child?.threadId !== attention?.id) {
            attention?.lease.release();
            attention = child
              ? { id: child.threadId, lease: session.client.thread(child.threadId) }
              : undefined;
          }
          showInteractions();
        } else if (threadId && previousStatus !== "uncertain") {
          previousStatus = "uncertain";
          emit({ type: "status", status: "uncertain", working: false, threadId });
        }
        await io.delay(500, signal);
      } catch (error) {
        if (signal.aborted) return;
        previousStatus = "uncertain";
        emit({
          type: "error",
          status: "uncertain",
          message: error instanceof Error ? error.message : "Tree observation failed",
        });
        await io.delay(500, signal).catch(() => {});
      }
    }
  };
  let observing: Promise<void> | undefined;
  const connection = session.client.connectionState();
  const fatal = () => {
    if (connection.getSnapshot() === "fatal" && !signal.aborted)
      lifetime.abort(
        new CliFailure(
          "uncertain",
          "Chat connection lost its authority; work admission is unconfirmed.",
          lastMutation ?? { threadId },
        ),
      );
  };
  const stopConnection = connection.subscribe(fatal);
  const cancelObservation = () => {
    if ((admitting || attaching) && quitRequested)
      lifetime.abort(
        new CliFailure(
          "uncertain",
          admitting
            ? "Detached before the command acknowledgement. Check the thread or retry with its key."
            : "Detached before the thread snapshot. Check the thread when connected.",
          lastMutation ?? { threadId },
        ),
      );
  };
  const stopInput = io.onLine((line) => {
    if (line.trim() === "/quit") {
      quitRequested = true;
      cancelObservation();
    }
  });
  const submit: typeof command = async (client, payload, id, observation) => {
    // Commit to the SDK outbox before a buffered quit cancels receipt observation.
    await client.enqueue(CommandPayload.parse(payload), id);
    admitting = true;
    cancelObservation();
    try {
      return await command(client, payload, id, observation);
    } finally {
      admitting = false;
    }
  };
  const mutate = async (payload: unknown) => {
    const id = io.id();
    lastMutation = { threadId, idempotencyKey: id };
    try {
      const receipt = await submit(session.client, payload, id, signal);
      emit({ type: "receipt", receipt });
    } finally {
      admitting = false;
    }
  };
  try {
    fatal();
    emit({ type: "ready" });
    if (threadId) await attach(ThreadId.parse(threadId));
    observing = observe();
    for await (const line of io.input) {
      if (signal.aborted) break;
      try {
        let action = chatAction(line);
        if (action.kind === "empty") continue;
        if (action.kind === "quit") break;
        if (action.kind === "help") {
          emit({ type: "help" });
          continue;
        }
        const pending = interactions();
        if (
          action.kind === "send" &&
          pending.length === 1 &&
          ["approval", "plan_review"].includes(pending[0]?.request.kind ?? "") &&
          /^[yn]$/i.test(action.text.trim())
        )
          action = {
            kind: action.text.trim().toLowerCase() === "y" ? "approve" : "deny",
            interaction: pending[0]?.id,
            option: undefined,
          };
        if (!threadId) {
          if (action.kind === "model") {
            model = action.model;
            continue;
          }
          if (action.kind !== "send")
            throw new CliFailure("refused", "Send a prompt to create a thread first");
          const project = session.remote
            ? await remoteWorkProject(option(args, "project"), session.client, signal)
            : option(args, "project");
          const id = option(args, "idempotency-key") ? key(args) : io.id();
          lastMutation = { threadId: runThreadId(id), idempotencyKey: id };
          const admission = await admitWork(
            {
              text: action.text,
              id,
              project,
              provider: option(args, "provider") ?? "codex",
              model,
              mode: "local",
              cwd: process.cwd(),
            },
            session.client,
            signal,
            submit,
          );
          admitting = false;
          threadId = admission.threadId;
          await attach(threadId, id);
          continue;
        }
        const id = ThreadId.parse(threadId);
        if (action.kind === "send" || action.kind === "steer")
          await mutate({
            type: "thread.send",
            threadId: id,
            input: [{ type: "text", text: action.text }],
            delivery: action.kind === "steer" ? "steer" : "queue",
          });
        else if (action.kind === "stop")
          await mutate({ type: "thread.interrupt", threadId: id, cascade: true });
        else if (action.kind === "model") {
          const provider = root?.store.thread?.provider;
          if (!provider) throw new CliFailure("uncertain", "Provider facts unavailable");
          await mutate({
            type: "thread.switch",
            threadId: id,
            selection: { provider: ProviderKind.parse(provider), model: action.model },
          });
        } else if (action.kind === "resume") {
          const target = ThreadId.parse(action.thread ?? id);
          const response = await session.client.request(
            { type: "queue.get", threadId: target },
            { signal },
          );
          await mutate({
            type: response.queue.paused ? "queue.resume" : "thread.resume",
            threadId: target,
            expectedRevision: response.queue.revision,
          });
        } else if (action.kind === "approve" || action.kind === "deny") {
          const selectedInteraction = action.interaction;
          const interaction = selectedInteraction
            ? pending.find((value) => value.id === selectedInteraction)
            : pending.length === 1
              ? pending[0]
              : undefined;
          if (!interaction)
            throw new CliFailure("refused", "Select one of the displayed pending interactions");
          await mutate({
            type: "interaction.resolve",
            interactionId: InteractionId.parse(interaction.id),
            resolution: approval(interaction, action.kind, action.option),
          });
        }
      } catch (error) {
        admitting = false;
        const status =
          error instanceof CliFailure
            ? error.outcome
            : error instanceof ClientError
              ? "uncertain"
              : "refused";
        const evidence =
          error instanceof CliFailure
            ? error.evidence
            : status === "uncertain"
              ? lastMutation
              : undefined;
        emit({
          type: "error",
          status,
          message: error instanceof Error ? error.message : "Chat action failed",
          ...(evidence === undefined ? {} : { admission: evidence }),
        });
        if (status === "uncertain" && !threadId && lastMutation !== undefined)
          lifetime.abort(
            new CliFailure(
              "uncertain",
              "Initial thread admission is unconfirmed. Check the admitted ID or retry the original prompt with its key.",
              evidence ?? lastMutation,
            ),
          );
      }
    }
    if (failure) throw failure;
    if (signal.aborted)
      throw signal.reason instanceof CliFailure
        ? signal.reason
        : new CliFailure(
            "uncertain",
            "Chat observation ended; work state is unconfirmed",
            lastMutation,
          );
    emit({ type: "detached", threadId });
    await output;
    if (failure) throw failure;
  } finally {
    lifetime.abort();
    stopConnection();
    stopInput();
    stopMessages();
    io.close();
    await observing;
    await output;
    attention?.lease.release();
    root?.release();
    await session.close();
  }
}
