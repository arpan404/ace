import type { CommandContext, Handlers } from "./context.ts";

/**
 * Threads, requests and projects (ADR 0176 §7). Each handler loads its module only when it
 * runs, so the rest of the CLI never carries this code.
 */
const reads = () => import("../work/thread-reads.ts");
const actions = () => import("../work/thread-actions.ts");
const requests = () => import("../work/request-commands.ts");
const projects = () => import("../work/project-commands.ts");

async function open(context: CommandContext): Promise<void> {
  const target = context.args.words[0];
  const byPath = context.parsed.typed[0] === "open" || !target || /[/\\.~]/.test(target[0] ?? "");
  if (byPath) {
    const args = { ...context.args, words: ["open", ...context.args.words] };
    return (await import("../open.ts")).openCommand(args, context.config());
  }
  // A project by name or id: find its id, then open it as the app does.
  const { withSession } = await import("./context.ts");
  let id = target;
  await withSession(context, context.args, async ({ client, signal }) => {
    id = (await (await import("../work/daemon.ts")).resolveProject(client, signal, target)).id;
  });
  const args = { ...context.args, words: ["project", "open", id] };
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
  "thread.list": async (context) => (await reads()).threadList(context),
  "thread.show": async (context) => (await reads()).threadShow(context),
  "thread.status": async (context) => (await reads()).threadStatus(context),
  "thread.tree": async (context) => (await reads()).threadTree(context),
  "thread.start": async (context) => (await actions()).threadStart(context),
  "thread.attach": attach,
  "thread.send": async (context) => (await actions()).threadMessage(context, "queue"),
  "thread.steer": async (context) => (await actions()).threadMessage(context, "steer"),
  "thread.stop": async (context) => (await actions()).threadStop(context),
  "thread.wait": async (context) => (await actions()).threadWait(context),
  "thread.resume": async (context) => (await actions()).threadResume(context),
  "thread.rename": async (context) => (await actions()).threadRename(context),
  "thread.settle": async (context) => (await actions()).threadSettle(context),
  "thread.unsettle": async (context) => (await actions()).threadUnsettle(context),
  "thread.snooze": async (context) => (await actions()).threadSnooze(context),
  "thread.fork": async (context) => (await actions()).threadFork(context),
  "thread.model": async (context) => (await actions()).threadModel(context),
  "request.list": async (context) => (await requests()).requestList(context),
  "request.show": async (context) => (await requests()).requestShow(context),
  "request.allow": async (context) => (await requests()).requestAllow(context),
  "request.deny": async (context) => (await requests()).requestDeny(context),
  "request.answer": async (context) => (await requests()).requestAnswer(context),
  "project.list": async (context) => (await projects()).projectList(context),
  "project.show": async (context) => (await projects()).projectShow(context),
  "project.add": async (context) => (await projects()).projectAdd(context),
  "project.rename": async (context) => (await projects()).projectRename(context),
  "project.remove": async (context) => (await projects()).projectRemove(context),
  "project.open": open,
};
