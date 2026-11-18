import { randomUUID } from "node:crypto";
import { ThreadId } from "@ace/protocol";
import { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import { words, type App } from "./app-context.ts";
import type { Commands } from "./app-commands.ts";
import { attachStart } from "./attach-model.ts";
import type { NewThread } from "./new-thread.ts";
import { threadRequests } from "./requests.ts";
import { foldedWork, titleLine, unfoldedLines } from "./transcript.ts";

/**
 * Attach's actions (ADR 0178 §9): opening a thread (or a fresh one), sending to it, its slash
 * commands, and unfolding a "Worked for" line.
 */
export function enterAttach(app: App, id: string | undefined, fresh?: NewThread): void {
  const live = app.live;
  if (!live) return;
  app.screen = "attach";
  app.attach = attachStart;
  live.follow("tree", undefined);
  app.attached = {
    id,
    fresh,
    printed: new Set(),
    hidden: new Set(),
    open: new Set(),
    reader: createBlockReader(),
    first: true,
  };
  if (id) {
    live.follow("attach", id);
    const entry = live.entry(id);
    if (entry)
      app.terminal.print([
        titleLine(
          {
            title: entry.title,
            project: entry.workspaceId,
            branch: entry.details?.branch ?? "",
            provider: entry.provider,
          },
          app.width(),
          app.ink,
        ),
      ]);
  } else
    app.terminal.print([
      app.ink.dim("A new thread. Type what the agent should do; Esc for the home."),
    ]);
  app.schedule();
}

/** The keys of the attached transcript's "Worked for" lines `↑` can reach, oldest first. */
export function attachedWork(app: App): string[] {
  const state = app.attached;
  const reader = app.live?.followed("attach")?.store;
  if (!state || !reader?.thread) return [];
  return foldedWork(state.reader(reader).value)
    .filter((block) => !state.hidden.has(block.key))
    .map((block) => block.key);
}

/**
 * Unfolds a "Worked for" line's steps: one already in the scrollback prints them below it;
 * one in the turn still running opens (or folds again) in place.
 */
export function unfold(app: App, key: string): void {
  const state = app.attached;
  const reader = app.live?.followed("attach")?.store;
  if (!state || !reader?.thread) return;
  const block = foldedWork(state.reader(reader).value).find((work) => work.key === key);
  if (!block) return app.flash("That work isn't in this thread any more.");
  if (state.printed.has(key))
    app.terminal.print(unfoldedLines(block, reader, Date.now(), app.width(), app.ink));
  else if (state.open.has(key)) state.open.delete(key);
  else state.open.add(key);
  app.schedule();
}

export async function send(
  app: App,
  commands: Commands,
  text: string,
  delivery: "queue" | "steer",
): Promise<void> {
  const { session, attached } = app;
  if (!session || !attached) return;
  if (attached.id) {
    await commands.submit(
      {
        type: "thread.send",
        threadId: ThreadId.parse(attached.id),
        input: [{ type: "text", text }],
        delivery,
      },
      delivery === "steer" ? "Steered." : "",
    );
    return;
  }
  const { admitWork } = await import("../work.ts");
  const fresh = attached.fresh;
  try {
    const admission = await admitWork(
      {
        text,
        id: randomUUID(),
        project: fresh?.project,
        provider: fresh?.provider ?? app.live?.defaultProvider() ?? "codex",
        model: fresh?.model,
        mode: "local",
        cwd: process.cwd(),
      },
      session.client,
      session.signal,
    );
    enterAttach(app, admission.threadId);
    app.flash(`Started ${admission.threadId}.`);
  } catch (error) {
    app.flash(words(error, "The thread didn't start."));
  }
}

export async function slash(app: App, commands: Commands, line: string): Promise<void> {
  const { slashCommand } = await import("./slash.ts");
  const reader = app.live?.followed("attach")?.store;
  await slashCommand(line, {
    threadId: app.attached?.id,
    provider: reader?.thread?.provider,
    pending: reader?.thread
      ? threadRequests(reader, { title: "", project: "", provider: reader.thread.provider })
      : [],
    flash: app.flash,
    submit: commands.submit,
    send: (text, delivery) => send(app, commands, text, delivery),
    quit: () => app.quit(leavingWords(app), 0),
    chooseModel: (model) => {
      const attached = app.attached;
      if (!attached) return;
      attached.fresh = {
        project: attached.fresh?.project ?? process.cwd(),
        provider: attached.fresh?.provider ?? app.live?.defaultProvider() ?? "codex",
        model,
      };
    },
    queue: async (threadId) => {
      const session = app.session;
      if (!session) throw new Error("ace isn't connected.");
      return (
        await session.client.request({ type: "queue.get", threadId }, { signal: session.signal })
      ).queue;
    },
  });
}

/** The one line left on screen on the way out: where the person was, and how to come back. */
export function leavingWords(app: App): string {
  const attached = app.attached;
  if (app.screen === "attach" && attached?.id) {
    const title = app.live?.entry(attached.id)?.title ?? attached.id;
    return `Detached from ${title} (${attached.id}). Back with ace chat ${attached.id}.`;
  }
  if (app.screen === "offline") return "ace isn't running. Start it with ace start.";
  const rows = app.live?.rows(Date.now()) ?? [];
  const needs = rows.filter((row) => row.needsYou).length;
  const running = rows.filter((row) => row.running).length;
  const parts = [
    needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "",
    running ? `${running} running` : "",
  ].filter(Boolean);
  return `Left the home${parts.length ? `: ${parts.join(", ")}` : ""}. Back with ace.`;
}
