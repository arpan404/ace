import { ProviderKind, type ThreadId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { latestForkPoint } from "@ace/ui-core";
import type { Args } from "../args.ts";
import { prompt } from "../io.ts";
import { command, key } from "../mutations.ts";
import { CliFailure, usageFailure } from "../output.ts";
import { legacy, withSession, without, type CommandContext } from "../run/context.ts";
import { resolveProject, resolveThread, withThread } from "./daemon.ts";
import { receipt, stringFlag } from "./output.ts";
import { snoozeUntil } from "./snooze.ts";
import { threadArgument } from "./thread-reads.ts";

/** The person's default provider from Settings (ADR 0176 §2); Codex if none is readable. */
export async function defaultProvider(client: Client, signal: AbortSignal): Promise<string> {
  try {
    const result = await client.request(
      { type: "settings.get", key: "providers.default", scope: {} },
      { signal },
    );
    const entry = result.entries.find((candidate) => candidate.key === "providers.default");
    const parsed = ProviderKind.safeParse(entry?.value);
    if (result.ok && parsed.success) return parsed.data;
  } catch {
    // An older daemon or a refused read leaves the default where it was.
    signal.throwIfAborted();
  }
  return "codex";
}

/** `--follow` is JSON Lines with `--json`, and the old `--stream jsonl` for the stream modules. */
function streamFlags(context: CommandContext): Record<string, string | true> {
  const flags = without(context.args.flags, "follow");
  return context.args.flags.follow && context.mode === "json"
    ? { ...flags, stream: "jsonl" }
    : flags;
}

export async function threadStart(context: CommandContext): Promise<void> {
  const flags = streamFlags(context);
  const human = context.args.flags.follow === true && context.mode !== "json";
  return withSession(context, context.args, async ({ client, signal, remote }) => {
    const provider =
      stringFlag(context.args, "provider") ?? (await defaultProvider(client, signal));
    const withProvider = { ...flags, provider };
    if (flags.parent) {
      const parent = await resolveThread(client, signal, String(flags.parent));
      const args = legacy(context, ["task", "spawn"], {
        ...without(withProvider, "project", "worktree"),
        parent,
      });
      return (await import("../tasks.ts")).taskCommand(args, client, signal);
    }
    const args = legacy(context, ["run"], without(withProvider, "role"));
    const projects = await import("../projects.ts");
    const target = remote
      ? await projects.remoteWorkProject(stringFlag(args, "project"), client, signal)
      : await localProject(client, signal, stringFlag(args, "project"));
    const id = await (await import("../work.ts")).runCommand(args, client, signal, target);
    const waits = await import("../waits.ts");
    if (args.flags.stream === "jsonl")
      await waits.waitThread({ ...args, flags: { ...args.flags, tree: true } }, client, id, signal);
    else if (human) await waits.followThread(context.args, client, id, signal);
  });
}

/** `--project` by name or id becomes the id; a path stays a path, registered on start. */
async function localProject(client: Client, signal: AbortSignal, ref: string | undefined) {
  if (!ref || ref.startsWith(".") || /[/\\]/.test(ref)) return ref;
  const { readProjects, findProject } = await import("./daemon.ts");
  return findProject(await readProjects(client, signal), ref, process.cwd()).id;
}

export async function threadMessage(context: CommandContext, delivery: "queue" | "steer") {
  return withSession(context, context.args, async ({ client, signal }) => {
    const id = await resolveThread(client, signal, context.args.words[0] ?? "");
    const text = await prompt(context.args, 1);
    const sent = await command(
      client,
      { type: "thread.send", threadId: id, input: [{ type: "text", text }], delivery },
      key(context.args),
      signal,
    );
    await receipt(context.args, sent, () =>
      delivery === "steer" ? "Sent into the current turn." : "Queued.",
    );
  });
}

export async function threadStop(context: CommandContext): Promise<void> {
  const { flags, words } = context.args;
  if (flags.all) {
    const args = { ...legacy(context, ["kill-all"], without(flags, "all")), words: ["kill-all"] };
    return withSession(context, args, async ({ client, signal }) => {
      const project = stringFlag(args, "project");
      const final = project
        ? {
            ...args,
            flags: { ...args.flags, project: (await resolveProject(client, signal, project)).id },
          }
        : args;
      return (await import("../control.ts")).controlCommand(final, client, signal);
    });
  }
  const given = words[0] ?? stringFlag(context.args, "thread");
  if (!given)
    throw usageFailure("ace thread stop needs THREAD, or --all.", {
      code: "missing_argument",
      argument: "THREAD",
      hint: "Pass its id, or --all to stop all running work.",
    });
  return withSession(context, context.args, async ({ client, signal }) => {
    const id = await resolveThread(client, signal, given);
    const stopped = await command(
      client,
      { type: "thread.interrupt", threadId: id, cascade: true },
      key(context.args),
      signal,
    );
    await receipt(context.args, stopped, () => "Stopped, with every agent under it.");
  });
}

export async function threadWait(context: CommandContext): Promise<void> {
  const flags = streamFlags(context);
  return withSession(context, context.args, async ({ client, signal }) => {
    const ids: ThreadId[] = [];
    for (const word of context.args.words) ids.push(await resolveThread(client, signal, word));
    const args: Args = { ...context.args, flags };
    const waits = await import("../waits.ts");
    if (context.args.flags.follow && context.mode !== "json" && ids.length === 1 && ids[0])
      return waits.followThread(
        { ...args, flags: { ...flags, tree: true } },
        client,
        ids[0],
        signal,
      );
    return waits.waitThreads(args, client, ids, signal, !!flags.tree);
  });
}

type Payload = Parameters<typeof command>[1];

/** One organising command on one thread, then the sentence that says it's done. */
async function organise(
  context: CommandContext,
  verb: string,
  build: (id: ThreadId, client: Client, signal: AbortSignal) => Promise<Payload> | Payload,
  done: string,
): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const id = await threadArgument(context, client, signal, `ace thread ${verb}`);
    const payload = await build(id, client, signal);
    const result = await command(client, payload, key(context.args), signal);
    await receipt(context.args, result, () => done);
  });
}

export const threadRename = (context: CommandContext) =>
  organise(
    context,
    "rename",
    (threadId) => {
      const title = (context.args.words[1] ?? "").trim();
      if (!title) throw usageFailure("NAME can't be empty.", { argument: "NAME" });
      return { type: "thread.rename", threadId, title };
    },
    "Renamed.",
  );

export const threadSettle = (context: CommandContext) =>
  organise(context, "settle", (threadId) => ({ type: "thread.settle", threadId }), "Settled.");

export const threadUnsettle = (context: CommandContext) =>
  organise(
    context,
    "unsettle",
    (threadId) => ({ type: "thread.unsettle", threadId }),
    "Back in the list.",
  );

export const threadModel = (context: CommandContext) =>
  organise(
    context,
    "model",
    (threadId) => ({ type: "thread.model.set", threadId, model: context.args.words[1] ?? "" }),
    "Model set; it applies from the next turn.",
  );

export async function threadSnooze(context: CommandContext): Promise<void> {
  const until = stringFlag(context.args, "until");
  if (!until)
    throw usageFailure("ace thread snooze needs --until.", {
      code: "missing_argument",
      argument: "--until",
      hint: "Say when it comes back: --until 1h, tomorrow, monday, needs-you or pr-changes.",
    });
  const choice = snoozeUntil(until, Date.now());
  return organise(
    context,
    "snooze",
    (threadId) => ({
      type: "thread.snooze",
      threadId,
      until: choice.until,
      ...(choice.wake ? { wake: choice.wake } : {}),
    }),
    choice.wake === "needs_you"
      ? "Snoozed until it needs you."
      : choice.wake === "pr"
        ? "Snoozed until its pull request changes."
        : `Snoozed until ${new Date(choice.until).toLocaleString()}.`,
  );
}

export const threadResume = (context: CommandContext) =>
  organise(
    context,
    "resume",
    (threadId, client, signal) =>
      withThread(client, threadId, signal, (store) => {
        const queue = store.queue;
        if (!queue?.paused)
          throw new CliFailure("refused", "This thread isn't stopped or paused.", undefined, {
            code: "conflict",
            hint: "Send it a message with ace thread send.",
          });
        return {
          type: queue.reason === "restart" ? "thread.resume" : "queue.resume",
          threadId,
          expectedRevision: queue.revision,
        };
      }),
    "Resumed.",
  );

export async function threadFork(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const id = await threadArgument(context, client, signal, "ace thread fork");
    const point = await withThread(client, id, signal, (store) =>
      latestForkPoint(store, store.thread?.rootAgentId),
    );
    if (!point)
      throw new CliFailure(
        "refused",
        "This thread has no finished answer to fork from yet.",
        undefined,
        {
          code: "conflict",
          hint: "Wait for its turn to end with ace thread wait.",
        },
      );
    const input =
      context.args.words[1] === undefined && context.args.interactive
        ? await (
            await import("../ask.ts")
          ).askText("What should the fork do?", "Or pass it: ace thread fork THREAD TEXT")
        : await prompt(context.args, 1);
    const title = stringFlag(context.args, "title")?.trim();
    const forked = await command(
      client,
      {
        type: "thread.fork",
        threadId: id,
        point,
        input,
        budgetBytes: 16384,
        ...(title ? { title } : {}),
      },
      key(context.args),
      signal,
    );
    await receipt(context.args, forked, (value) =>
      value.forkThreadId ? `Forked into ${value.forkThreadId}.` : "Forked.",
    );
  });
}
