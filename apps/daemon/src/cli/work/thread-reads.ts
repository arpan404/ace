import { CliTaskStatus, CliTree, ThreadId, type Item } from "@ace/protocol";
import type { Client } from "@ace/client";
import { treeOutcome } from "../../work-outcome.ts";
import { CliFailure, usageFailure, type Outcome } from "../output.ts";
import { withSession, type CommandContext } from "../run/context.ts";
import { threadListLines } from "../render/thread-list.ts";
import { rootState, threadShowLines, treeLines } from "../render/thread.ts";
import {
  findProject,
  projectNames,
  readProjects,
  readThreadList,
  resolveThread,
  withThread,
} from "./daemon.ts";
import { colourOn, limitFlag, show, stringFlag, terminalWidth } from "./output.ts";
import { missing, pickThread } from "./pick.ts";
import { pageRows, threadListJson, threadRows, unseenWindowMs } from "./rows.ts";

/** Rows of the thread list, in the app's order (the I/O around `threadRows`). */
export async function listRows(
  client: Client,
  signal: AbortSignal,
  input: {
    project?: string | undefined;
    filter?: Parameters<typeof threadRows>[0]["filter"];
    want: number;
  },
) {
  // A device paired with read-only scopes may list threads without the project list: rows
  // then go without project names, unless a project was asked for by name.
  const projects = await readProjects(client, signal).catch((error: unknown) => {
    if (!input.project && error instanceof CliFailure && error.detail.code === "forbidden")
      return [];
    throw error;
  });
  const project = input.project ? findProject(projects, input.project, process.cwd()) : undefined;
  const list = await readThreadList(client, signal, { project: project?.id, want: input.want });
  const now = Date.now();
  const rows = threadRows({
    entries: list.entries,
    projectNames: projectNames(projects),
    now,
    baseline: now - unseenWindowMs,
    ...(input.filter ? { filter: input.filter } : {}),
  });
  return { ...rows, list, now, projects };
}

export async function threadList(context: CommandContext): Promise<void> {
  const { args } = context;
  const limit = limitFlag(args, 50, 500);
  const after = stringFlag(args, "after");
  return withSession(context, args, async ({ client, signal }) => {
    const filter = {
      needsYou: args.flags["needs-you"] === true,
      running: args.flags.running === true,
      settled: args.flags.settled === true,
    };
    const { rows, settled, snoozed, list, now } = await listRows(client, signal, {
      project: stringFlag(args, "project"),
      filter,
      want: 500,
    });
    const page = pageRows(rows, limit, after);
    const value = threadListJson(list.entries, page, list.window);
    const command = ["ace thread list", ...flagWords(args.flags)].join(" ");
    await show(args, value, {
      human: () =>
        threadListLines(
          { rows: page.rows, next: page.next, settled, snoozed, command },
          { now, colour: colourOn(context), width: terminalWidth() },
        ),
      quiet: () => page.rows.map((row) => row.threadId),
    });
  });
}

function flagWords(flags: Readonly<Record<string, string | true>>): string[] {
  return ["project", "needs-you", "running", "settled", "limit"].flatMap((name) => {
    const value = flags[name];
    if (value === undefined) return [];
    return value === true ? [`--${name}`] : [`--${name}`, value];
  });
}

/** The thread named by `words[index]`, or picked on a terminal (ADR 0176 §9). */
export async function threadArgument(
  context: CommandContext,
  client: Client,
  signal: AbortSignal,
  command: string,
  index = 0,
): Promise<ThreadId> {
  const given = context.args.words[index];
  if (given !== undefined) return resolveThread(client, signal, given);
  const { rows } = await listRows(client, signal, { want: 50 });
  return ThreadId.parse(await pickThread(context.args, rows, command));
}

export async function treeOf(client: Client, id: ThreadId, signal: AbortSignal): Promise<CliTree> {
  const response = await client.request(
    { type: "cli.request", operation: { op: "thread.tree", threadId: id } },
    { signal },
  );
  if (!response.result.ok) {
    // A thread the daemon doesn't hold reads the same as one this device may not read.
    if (response.result.code === "not_found" || response.result.code === "forbidden")
      throw new CliFailure("refused", `No thread ${id} on this machine.`, undefined, {
        code: "not_found",
        argument: "THREAD",
        hint: "See your threads with ace thread list.",
      });
    throw new CliFailure("uncertain", "ace couldn't read this thread's agents yet.", undefined, {
      hint: "Try again in a moment.",
    });
  }
  return CliTree.parse(response.result.data);
}

function itemsFlag(context: CommandContext): number {
  const value = context.args.flags.items;
  const fallback = context.mode === "json" ? 200 : 20;
  if (value === undefined) return fallback;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(number >= 1 && number <= 200))
    throw usageFailure("--items takes a number from 1 to 200.", { argument: "--items" });
  return number;
}

export async function threadShow(context: CommandContext): Promise<void> {
  const { args } = context;
  const count = itemsFlag(context);
  const before = stringFlag(args, "before");
  if (before !== undefined && !/^\d+$/.test(before))
    throw usageFailure("--before takes the number printed after Earlier:.", {
      argument: "--before",
    });
  if (args.words[0] === undefined && !args.interactive)
    throw missing(
      "ace thread show",
      "THREAD",
      "Pass a thread id: ace thread show THREAD. See them with ace thread list.",
    );
  return withSession(context, args, async ({ client, signal }) => {
    const id = await threadArgument(context, client, signal, "ace thread show");
    const tree = await treeOf(client, id, signal).catch(() => undefined);
    const value = await withThread(client, id, signal, async (store) => {
      const thread = store.thread;
      if (!thread) throw new CliFailure("uncertain", "Thread state unavailable");
      let items: Item[];
      let itemsBefore: number | null;
      if (before !== undefined) {
        const page = await client.itemsPage(
          { threadId: id, before: Number(before), limit: count },
          { signal },
        );
        items = page.items;
        itemsBefore = page.itemsBefore;
      } else {
        const order = store.order.slice(-count);
        items = order.flatMap((itemId) => {
          const item = store.item(itemId);
          return item ? [item] : [];
        });
        const first = order[0];
        const cut = store.order.length > order.length;
        itemsBefore = cut && first ? (store.itemSeq?.(first) ?? null) : (store.itemsBefore ?? null);
      }
      return {
        thread,
        items,
        itemsBefore,
        interactions: store.interactionIds().flatMap((interactionId) => {
          const interaction = store.interaction(interactionId);
          return interaction ? [interaction] : [];
        }),
      };
    });
    const meaning = tree ? rootState(tree)?.words : undefined;
    await show(args, value, {
      human: (view) => threadShowLines({ ...view, meaning }, colourOn(context)),
      quiet: (view) => [view.thread.id],
    });
  });
}

function treeExit(tree: CliTree): Outcome {
  const outcome = treeOutcome(tree);
  return outcome === undefined ? "ok" : outcome;
}

export async function threadTree(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const id = await threadArgument(context, client, signal, "ace thread tree");
    const tree = await treeOf(client, id, signal);
    await show(context.args, tree, {
      human: (value) => treeLines(value, colourOn(context)),
      quiet: (value) => value.map((member) => member.threadId),
    });
  });
}

/**
 * `ace thread status`: a delegated child keeps the task view agents already read; any other
 * thread reads its whole tree. The exit code follows the tree, never the root alone.
 */
export async function threadStatus(context: CommandContext): Promise<void> {
  return withSession(context, context.args, async ({ client, signal }) => {
    const id = await threadArgument(context, client, signal, "ace thread status");
    const task = await client.request(
      { type: "cli.request", operation: { op: "task.status", threadId: id } },
      { signal },
    );
    const tree = await treeOf(client, id, signal);
    const state = rootState(tree);
    const human = () => [
      `${state?.symbol ?? ""} ${state?.words ?? "Unknown"}`.trim(),
      ...treeLines(tree, colourOn(context)).slice(1),
    ];
    if (task.result.ok) {
      const view = CliTaskStatus.parse(task.result.data);
      const outcome: Outcome =
        view.state === "unresponsive"
          ? "uncertain"
          : view.state === "waiting_on_human"
            ? "needs-human"
            : ["failed", "cancelled"].includes(view.state)
              ? "failed"
              : "ok";
      return show(context.args, task.result.data, { human, quiet: () => [id] }, outcome);
    }
    const outcome = treeOutcome(tree);
    const root = tree[0];
    const value = {
      threadId: id,
      status: root?.status ?? { state: "unresponsive" as const },
      state: outcome ?? "working",
      tree,
    };
    await show(context.args, value, { human, quiet: () => [id] }, treeExit(tree));
  });
}
