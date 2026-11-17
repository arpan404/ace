import { randomUUID } from "node:crypto";
import { ClientError, type Client } from "@ace/client";
import { ThreadId, type CommandPayload, type ProviderKind } from "@ace/protocol";
import { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import type { Args } from "../args.ts";
import type { CommandTable } from "../commands/table.ts";
import { useColor } from "../input-mode.ts";
import { composerOf } from "../tui/composer.ts";
import type { Key } from "../tui/keys.ts";
import { paint } from "../tui/paint.ts";
import { openTerminal, type Terminal } from "../tui/terminal.ts";
import { editText, placeWords, runInPlace } from "./actions.ts";
import { attachKey, attachStart, type AttachState } from "./attach-model.ts";
import { attachView } from "./attach-view.ts";
import type { Effect } from "./effects.ts";
import { homeKey, homeStart, type HomeState } from "./home-model.ts";
import { homeView, keysLine } from "./home-view.ts";
import { openLive, type Live } from "./live.ts";
import { askNewThread, type NewThread } from "./new-thread.ts";
import {
  requestsKey,
  requestsStart,
  requestsView,
  threadRequests,
  type RequestsState,
} from "./requests.ts";
import { blockLines, liveLine, settledBlocks, titleLine } from "./transcript.ts";
import { agentTree } from "./tree.ts";

/**
 * The interactive shell (ADR 0176 §9): one terminal, one connection, and the home, requests
 * and attach views over the client's stores. Models and views are pure; this file wires keys
 * to them and carries out their effects.
 */
export interface AppStart {
  readonly args: Args;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly table: CommandTable;
  /** Open attached (`ace chat`): to a thread, or fresh to start one. */
  readonly attach?:
    | {
        threadId?: string | undefined;
        fresh?:
          | {
              project?: string | undefined;
              provider?: ProviderKind | undefined;
              model?: string | undefined;
            }
          | undefined;
      }
    | undefined;
  /** Start the daemon when it isn't running (`ace chat` does; the home asks first). */
  readonly startDaemon: boolean;
  /** A terminal already opened (the home draws its first line before this module loads). */
  readonly terminal?: Terminal | undefined;
}

type Screen = "home" | "requests" | "attach" | "offline";

/** Turns kept on screen when attaching: older history stays in `ace thread show`. */
const turnsShown = 3;

export async function runApp(start: AppStart): Promise<void> {
  const terminal =
    start.terminal ??
    openTerminal({ input: process.stdin, output: process.stdout, process, fd: 1 });
  const ink = paint(
    useColor({
      flags: start.args.flags,
      env: start.env,
      stdinTTY: true,
      stdoutTTY: process.stdout.isTTY === true,
    }),
  );
  terminal.draw({ lines: [`ace  ${ink.dim("Connecting…")}`] });
  let screen: Screen = "home";
  let home: HomeState = homeStart;
  let requests: RequestsState = requestsStart;
  let attach: AttachState = attachStart;
  let attached:
    | {
        id: string | undefined;
        fresh: NewThread | undefined;
        printed: Set<string>;
        reader: ReturnType<typeof createBlockReader>;
        first: boolean;
      }
    | undefined;
  let session:
    | { client: Client; signal: AbortSignal; close(): Promise<void>; remote: boolean }
    | undefined;
  let live: Live | undefined;
  let finished: ((farewell: string) => void) | undefined;
  // Keys run one after another, so a burst of typing is never dropped or reordered.
  let keys = Promise.resolve();
  const done = new Promise<string>((resolve) => {
    finished = resolve;
  });
  let leaving = false;
  const quit = (farewell: string, code: number) => {
    if (leaving) return;
    leaving = true;
    if (code) process.exitCode = code;
    finished?.(farewell);
  };
  const flash = (text: string) => {
    if (screen === "attach") attach = { ...attach, notice: text };
    else home = { ...home, notice: text };
    schedule();
  };

  // Redraws coalesce: a burst of store changes is one frame.
  let redraw: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    redraw ??= setTimeout(() => {
      redraw = undefined;
      render();
    }, 16);
  };
  const ticker = setInterval(() => schedule(), 1000);
  ticker.unref();

  const width = () => terminal.columns - 1;
  const height = () => terminal.rows - 1;

  function renderAttach(): void {
    const state = attached;
    if (!state) return;
    const lease = state.id ? live?.followed("attach") : undefined;
    const reader = lease?.store;
    const now = Date.now();
    let turn: string[] = [];
    let open = undefined as ReturnType<typeof threadRequests> | undefined;
    let activity = undefined as ReturnType<typeof liveLine>;
    if (reader?.thread) {
      const blocks = state.reader(reader).value;
      activity = liveLine(reader, now);
      const atRest = !activity && ["done", "failed", "new"].includes(reader.thread.status.state);
      const settled = settledBlocks(blocks, atRest);
      if (state.first) {
        // Only the last few turns go to the scrollback; the rest is a line away.
        state.first = false;
        const users = blocks.flatMap((block, index) => (block.kind === "user" ? [index] : []));
        const from = users.length > turnsShown ? (users[users.length - turnsShown] ?? 0) : 0;
        for (const block of blocks.slice(0, from)) state.printed.add(block.key);
        if (from > 0) terminal.print([ink.dim(`Earlier turns: ace thread show ${state.id}`)]);
      }
      const fresh = blocks.slice(0, settled).filter((block) => !state.printed.has(block.key));
      const lines = fresh.flatMap((block) => {
        state.printed.add(block.key);
        return blockLines(block, reader, now, width(), ink);
      });
      if (lines.length) terminal.print(lines);
      turn = blocks.slice(settled).flatMap((block) => blockLines(block, reader, now, width(), ink));
      const entry = state.id ? live?.entry(state.id) : undefined;
      open = threadRequests(reader, {
        title: reader.thread.title,
        project: entry?.workspaceId ?? "",
        provider: reader.thread.provider,
      });
    } else if (state.id)
      turn = [ink.dim(reader?.error ? reader.error.message : "Reading the thread…")];
    const frame = attachView(
      attach,
      {
        turn,
        request: open?.[0],
        requests: open?.length ?? 0,
        live: activity,
        fresh: state.id === undefined,
        connection: live?.connection(),
      },
      width(),
      height(),
      ink,
    );
    terminal.draw(frame);
  }

  function render(): void {
    if (screen === "offline") {
      terminal.draw({
        lines: [
          "ace isn't running.",
          keysLine(["s Start ace", "d Doctor", "t Triage", "q quit"], width()),
        ],
      });
      return;
    }
    if (!live) return;
    if (screen === "attach") return renderAttach();
    if (screen === "requests") {
      terminal.draw(requestsView(requests, live.requests(), width(), height(), ink));
      return;
    }
    const tree = home.open ? live.followed("tree")?.store : undefined;
    terminal.draw({
      lines: homeView(
        home,
        {
          rows: live.rows(Date.now()),
          loading: live.loading(),
          requests:
            live.requests().length || live.rows(Date.now()).filter((row) => row.needsYou).length,
          tree: tree?.thread ? agentTree(tree, Date.now()) : undefined,
          connection: live.connection(),
        },
        width(),
        height(),
        ink,
      ),
    });
  }

  async function connect(): Promise<boolean> {
    const { connectChat } = await import("../connection.ts");
    if (!start.args.flags.remote && !(await daemonUp(start.dataDir))) {
      if (!start.startDaemon) return false;
      terminal.draw({ lines: [ink.dim("Starting ace…")] });
      const { ensureDaemon, systemOpenRuntime } = await import("../open-runtime.ts");
      await ensureDaemon(start.dataDir, start.args, systemOpenRuntime());
    }
    session = await connectChat(start.dataDir, start.args);
    live = openLive(session.client, session.signal, schedule);
    session.signal.addEventListener("abort", () => quit("The connection to ace closed.", 1), {
      once: true,
    });
    return true;
  }

  function enterAttach(id: string | undefined, fresh?: NewThread): void {
    if (!live) return;
    screen = "attach";
    attach = attachStart;
    live.follow("tree", undefined);
    attached = { id, fresh, printed: new Set(), reader: createBlockReader(), first: true };
    if (id) {
      live.follow("attach", id);
      const entry = live.entry(id);
      if (entry)
        terminal.print([
          titleLine(
            {
              title: entry.title,
              project: entry.workspaceId,
              branch: entry.details?.branch ?? "",
              provider: entry.provider,
            },
            width(),
            ink,
          ),
        ]);
    } else
      terminal.print([ink.dim("A new thread. Type what the agent should do; Esc for the home.")]);
    schedule();
  }

  async function submit(payload: CommandPayload, doneText: string): Promise<void> {
    if (!session) return;
    const { command } = await import("../mutations.ts");
    try {
      await command(session.client, payload, randomUUID(), session.signal);
      if (doneText) flash(doneText);
    } catch (error) {
      flash(error instanceof Error ? error.message : "That didn't go through.");
    }
  }

  async function send(text: string, delivery: "queue" | "steer"): Promise<void> {
    if (!session || !attached) return;
    if (attached.id) {
      await submit(
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
          provider: fresh?.provider ?? live?.defaultProvider() ?? "codex",
          model: fresh?.model,
          mode: "local",
          cwd: process.cwd(),
        },
        session.client,
        session.signal,
      );
      enterAttach(admission.threadId);
      flash(`Started ${admission.threadId}.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : "The thread didn't start.");
    }
  }

  async function slash(line: string): Promise<void> {
    const { slashCommand } = await import("./slash.ts");
    const reader = live?.followed("attach")?.store;
    await slashCommand(line, {
      threadId: attached?.id,
      provider: reader?.thread?.provider,
      pending: reader?.thread
        ? threadRequests(reader, { title: "", project: "", provider: reader.thread.provider })
        : [],
      flash,
      submit,
      send,
      quit: () => quit(leavingWords(), 0),
      chooseModel: (model) => {
        if (!attached) return;
        attached.fresh = {
          project: attached.fresh?.project ?? process.cwd(),
          provider: attached.fresh?.provider ?? live?.defaultProvider() ?? "codex",
          model,
        };
      },
      queue: async (threadId) => {
        if (!session) throw new Error("ace isn't connected.");
        return (
          await session.client.request({ type: "queue.get", threadId }, { signal: session.signal })
        ).queue;
      },
    });
  }

  async function effect(next: Effect): Promise<void> {
    switch (next.kind) {
      case "quit":
        return quit(next.farewell || leavingWords(), next.code);
      case "command":
        return submit(next.payload, next.done);
      case "attach":
        return enterAttach(next.threadId);
      case "home":
        screen = "home";
        live?.follow("attach", undefined);
        attached = undefined;
        return schedule();
      case "requests":
        screen = "requests";
        requests = requestsStart;
        return schedule();
      case "tree":
        live?.follow("tree", next.threadId);
        return schedule();
      case "send":
        return send(next.text, next.delivery);
      case "slash":
        return slash(next.line);
      case "editor":
        attach = { ...attach, composer: composerOf(editText(terminal, next.text, start.env)) };
        return schedule();
      case "new-thread": {
        const chosen = await askNewThread(terminal, {
          cwd: process.cwd(),
          projects: live?.projects() ?? [],
          defaultProvider: live?.defaultProvider(),
        });
        if (chosen) enterAttach(undefined, chosen);
        return schedule();
      }
      case "place": {
        const words = placeWords(start.table, next.place);
        if (!words) return flash(`This build of ace can't show ${next.place} here yet.`);
        if (next.place === "market" && words.includes("search")) {
          terminal.suspend();
          const query = await import("../ask.ts")
            .then((ask) =>
              ask.askText("Search the market (ace market search)", "A name, a word, a publisher"),
            )
            .catch(() => undefined);
          terminal.resume();
          if (!query) return schedule();
          words.push(query);
        }
        await runInPlace(terminal, words);
        return schedule();
      }
      case "doctor":
        await runInPlace(terminal, ["doctor"]);
        return schedule();
      case "triage":
        await runInPlace(terminal, ["triage"]);
        return schedule();
      case "start":
        return;
    }
  }

  function leavingWords(): string {
    if (screen === "attach" && attached?.id) {
      const title = live?.entry(attached.id)?.title ?? attached.id;
      return `Detached from ${title} (${attached.id}). Back with ace chat ${attached.id}.`;
    }
    if (screen === "offline") return "ace isn't running. Start it with ace start.";
    const rows = live?.rows(Date.now()) ?? [];
    const needs = rows.filter((row) => row.needsYou).length;
    const running = rows.filter((row) => row.running).length;
    const parts = [
      needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "",
      running ? `${running} running` : "",
    ].filter(Boolean);
    return `Left the home${parts.length ? `: ${parts.join(", ")}` : ""}. Back with ace.`;
  }

  async function offlineKey(key: Key): Promise<void> {
    const char = key.name === "char" && !key.ctrl ? key.text : undefined;
    if (char === "q" || (key.ctrl && key.text === "c"))
      return quit(leavingWords(), key.ctrl ? 130 : 0);
    if (char === "d") await runInPlace(terminal, ["doctor"]);
    if (char === "t") await runInPlace(terminal, ["triage"]);
    if (char === "s") {
      terminal.draw({ lines: [ink.dim("Starting ace…")] });
      try {
        const { ensureDaemon, systemOpenRuntime } = await import("../open-runtime.ts");
        await ensureDaemon(start.dataDir, start.args, systemOpenRuntime());
        if (await connect()) screen = "home";
      } catch (error) {
        terminal.print([
          error instanceof Error ? error.message : "ace didn't start. Try ace doctor.",
        ]);
      }
    }
    schedule();
  }

  const onKey = (key: Key) => {
    const run = async () => {
      if (screen === "offline") return offlineKey(key);
      if (!live) return;
      let effects: readonly Effect[] = [];
      if (screen === "home") {
        const next = homeKey(home, live.rows(Date.now()), key);
        home = next.state;
        effects = next.effects;
      } else if (screen === "requests") {
        const next = requestsKey(requests, live.requests(), key, height() - 6);
        requests = next.state;
        effects = next.effects;
      } else {
        const reader = live.followed("attach")?.store;
        const open = reader?.thread
          ? threadRequests(reader, {
              title: reader.thread.title,
              project: "",
              provider: reader.thread.provider,
            })
          : [];
        const next = attachKey(attach, open[0], key, height() - 8);
        attach = next.state;
        effects = next.effects;
      }
      schedule();
      for (const each of effects) {
        // Daemon round trips report when they land; keys go on meanwhile. Effects that hand
        // the terminal over (prompts, the editor, doctor) hold the next keys until they return.
        if (each.kind === "command" || each.kind === "send" || each.kind === "slash")
          void effect(each).catch((error: unknown) =>
            flash(error instanceof Error ? error.message : String(error)),
          );
        else await effect(each);
      }
    };
    keys = keys
      .then(run)
      .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
      .finally(schedule);
  };

  const stopKeys = terminal.onKey(onKey);
  const stopResize = terminal.onResize(() => render());
  const stopSignal = terminal.onSignal((signal) =>
    quit(leavingWords(), signal === "SIGINT" ? 130 : 143),
  );
  let message = "";
  try {
    try {
      if (!(await connect())) screen = "offline";
      else if (start.attach) {
        const fresh = start.attach.fresh;
        enterAttach(
          start.attach.threadId,
          fresh && {
            project: fresh.project ?? process.cwd(),
            provider: fresh.provider ?? live?.defaultProvider() ?? "codex",
            model: fresh.model,
          },
        );
      }
    } catch (error) {
      if (!isOffline(error)) throw error;
      screen = "offline";
    }
    render();
    message = await done;
  } finally {
    clearInterval(ticker);
    if (redraw) clearTimeout(redraw);
    stopKeys();
    stopResize();
    stopSignal();
    live?.close();
    terminal.close(message || undefined);
    await session?.close().catch(() => {});
  }
}

function isOffline(error: unknown): boolean {
  if (error instanceof ClientError) return error.code === "offline" || error.code === "timeout";
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
  );
}

/** Whether the local daemon answers its status, quickly; false when it isn't running. */
async function daemonUp(home: string): Promise<boolean> {
  const { hostConnection } = await import("../connection.ts");
  const { accessRequest } = await import("../../client-access.ts");
  try {
    const connection = hostConnection(home);
    await Promise.race([
      accessRequest(connection.origin, "/v1/status", { token: connection.token }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new ClientError("timeout")), 1500).unref(),
      ),
    ]);
    return true;
  } catch (error) {
    if (isOffline(error)) return false;
    return true;
  }
}
