import { option } from "../args.ts";
import { usageFailure } from "../output.ts";
import { legacy, withSession, without, type CommandContext, type Handlers } from "./context.ts";

/** `--follow` is the old `--stream jsonl` for the modules that stream. */
function streamed(context: CommandContext): Record<string, string | true> {
  const flags = without(context.args.flags, "follow");
  return context.args.flags.follow ? { ...flags, stream: "jsonl" } : flags;
}

async function start(context: CommandContext): Promise<void> {
  const flags = streamed(context);
  if (flags.parent) {
    const args = legacy(context, ["task", "spawn"], without(flags, "project", "worktree"));
    return withSession(context, args, async ({ client, signal }) =>
      (await import("../tasks.ts")).taskCommand(args, client, signal),
    );
  }
  const args = legacy(context, ["run"], without(flags, "role"));
  return withSession(context, args, async ({ client, signal, remote }) => {
    const target = remote
      ? await (
          await import("../projects.ts")
        ).remoteWorkProject(option(args, "project"), client, signal)
      : option(args, "project");
    const id = await (await import("../work.ts")).runCommand(args, client, signal, target);
    if (args.flags.stream === "jsonl")
      await (
        await import("../threads.ts")
      ).waitThread({ ...args, flags: { ...args.flags, tree: true } }, client, id, signal);
  });
}

async function thread(context: CommandContext, verb: string): Promise<void> {
  const args = legacy(context, ["thread", verb], streamed(context));
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../threads.ts")).threadCommand(args, client, signal),
  );
}

async function stop(context: CommandContext): Promise<void> {
  const { flags, words } = context.args;
  if (flags.all) {
    const args = { ...legacy(context, ["kill-all"], without(flags, "all")), words: ["kill-all"] };
    return withSession(context, args, async ({ client, signal }) =>
      (await import("../control.ts")).controlCommand(args, client, signal),
    );
  }
  const id = words[0] ?? (typeof flags.thread === "string" ? flags.thread : undefined);
  if (!id)
    throw usageFailure("Say which thread to stop.", {
      code: "missing_argument",
      argument: "THREAD",
      hint: "Pass its id, or --all to stop all running work.",
    });
  const args = {
    ...context.args,
    words: ["thread", "cancel", id],
    flags: without(flags, "thread"),
  };
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../threads.ts")).threadCommand(args, client, signal),
  );
}

async function answer(context: CommandContext, verb: "approve" | "deny"): Promise<void> {
  const { flags, words } = context.args;
  const threadId = typeof flags.thread === "string" ? flags.thread : undefined;
  if (!threadId)
    throw usageFailure("Say which thread's request to answer.", {
      code: "missing_argument",
      argument: "--thread",
      hint: "Pass --thread THREAD; see what's open with ace thread show THREAD.",
    });
  const request = words[0] ?? (typeof flags.request === "string" ? flags.request : undefined);
  const args = {
    ...context.args,
    words: ["thread", verb, threadId],
    flags: {
      ...without(flags, "thread", "request"),
      ...(request ? { interaction: request } : {}),
    },
  };
  return withSession(context, args, async ({ client, signal }) =>
    (await import("../threads.ts")).threadCommand(args, client, signal),
  );
}

async function project(context: CommandContext, verb: string): Promise<void> {
  const args = legacy(context, ["project", verb]);
  return withSession(context, args, async ({ client, signal, remote }) =>
    (await import("../projects.ts")).projectCommand(args, client, signal, remote),
  );
}

async function open(context: CommandContext): Promise<void> {
  const target = context.args.words[0];
  const byPath = context.parsed.typed[0] === "open" || !target || /[/\\.]/.test(target[0] ?? "");
  const args = byPath
    ? legacy(context, ["open"])
    : { ...context.args, words: ["project", "open", target] };
  return (await import("../open.ts")).openCommand(args, context.config());
}

async function attach(context: CommandContext): Promise<void> {
  const { flags, words } = context.args;
  const id = words[0] ?? flags.thread;
  const args = {
    ...context.args,
    words: ["chat"],
    flags: { ...flags, ...(typeof id === "string" ? { thread: id } : {}) },
  };
  return (await import("../chat.ts")).chatCommand(args, context.config());
}

export const workHandlers: Handlers = {
  "thread.list": async (context) => {
    const args = legacy(context, ["threads", "list"]);
    return withSession(context, args, async ({ client, signal }) =>
      (await import("../threads.ts")).listThreads(args, client, signal),
    );
  },
  "thread.show": (context) => thread(context, "read"),
  "thread.start": start,
  "thread.attach": attach,
  "thread.send": (context) => thread(context, "send"),
  "thread.steer": (context) => thread(context, "steer"),
  "thread.stop": stop,
  "thread.wait": (context) => thread(context, "wait"),
  "thread.status": async (context) => {
    const args = legacy(context, ["task", "status"]);
    return withSession(context, args, async ({ client, signal }) =>
      (await import("../tasks.ts")).taskCommand(args, client, signal),
    );
  },
  "request.allow": (context) => answer(context, "approve"),
  "request.deny": (context) => answer(context, "deny"),
  "project.list": (context) => project(context, "list"),
  "project.add": (context) => project(context, "add"),
  "project.rename": (context) => project(context, "rename"),
  "project.remove": (context) => project(context, "remove"),
  "project.open": open,
};
