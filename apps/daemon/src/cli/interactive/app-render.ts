import { turnsShown, type App } from "./app-context.ts";
import { attachView } from "./attach-view.ts";
import { keepRows } from "./home-cache.ts";
import { homeView, keysLine } from "./home-view.ts";
import { requestsView, threadRequests } from "./requests.ts";
import {
  blockLines,
  foldedWork,
  liveLine,
  settledBlocks,
  unfoldedLines,
  workLine,
} from "./transcript.ts";
import { agentTree } from "./tree.ts";

/**
 * Draws the current screen (ADR 0178 §9) from the app's state and the live stores: the home
 * (with the last run's rows, unconfirmed, until the live list arrives), the requests walk,
 * attach, or the line saying ace isn't running.
 */
export function render(app: App): void {
  const { terminal, ink, live } = app;
  if (app.screen === "offline") {
    terminal.draw({
      lines: [
        "ace isn't running.",
        keysLine(["s Start ace", "d Doctor", "t Triage", "q quit"], app.width()),
      ],
    });
    return;
  }
  if (app.screen === "attach") return renderAttach(app);
  if (app.screen === "requests") {
    if (live)
      terminal.draw(requestsView(app.requests, live.requests(), app.width(), app.height(), ink));
    return;
  }
  renderHome(app);
}

function renderHome(app: App): void {
  const { live } = app;
  const now = Date.now();
  const rows = live?.rows(now) ?? [];
  const kept = app.start.kept ?? [];
  // Until the live list arrives, the last run's rows stand in, each saying "Syncing".
  const waiting = !live || live.loading();
  const shown = waiting && !rows.length ? kept : rows;
  const tree = app.home.open ? live?.followed("tree")?.store : undefined;
  const connection = live
    ? (live.connection() ?? (waiting && shown.length ? "Reading your threads…" : undefined))
    : "Connecting…";
  app.terminal.draw({
    lines: homeView(
      app.home,
      {
        rows: shown,
        loading: waiting,
        requests: live ? live.requests().length || rows.filter((row) => row.needsYou).length : 0,
        tree: tree?.thread ? agentTree(tree, now) : undefined,
        connection,
      },
      app.width(),
      app.height(),
      app.ink,
    ),
  });
  if (!app.kept) keepLive(app);
}

/**
 * Keeps the live list for the next run's first frame, when the daemon has confirmed it: once
 * when it first is, and again on the way out. A remote's list is never kept.
 */
export function keepLive(app: App): void {
  const live = app.live;
  if (!live || app.start.args.flags.remote || !live.confirmed()) return;
  app.kept = true;
  keepRows(app.start.dataDir, live.rows(Date.now()));
}

function renderAttach(app: App): void {
  const { attached: state, live, terminal, ink } = app;
  if (!state) return;
  const width = app.width();
  const lease = state.id ? live?.followed("attach") : undefined;
  const reader = lease?.store;
  const now = Date.now();
  let turn: string[] = [];
  let open = undefined as ReturnType<typeof threadRequests> | undefined;
  let activity = undefined as ReturnType<typeof liveLine>;
  let focus: string | undefined;
  let work = false;
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
      for (const block of blocks.slice(0, from)) {
        state.printed.add(block.key);
        state.hidden.add(block.key);
      }
      if (from > 0) terminal.print([ink.dim(`Earlier turns: ace thread show ${state.id}`)]);
    }
    // A block unfolded while its turn ran goes to the scrollback unfolded.
    const drawn = (block: (typeof blocks)[number]) =>
      block.kind === "work" && state.open.has(block.key)
        ? unfoldedLines(block, reader, now, width, ink)
        : blockLines(block, reader, now, width, ink);
    const fresh = blocks.slice(0, settled).filter((block) => !state.printed.has(block.key));
    const lines = fresh.flatMap((block) => {
      state.printed.add(block.key);
      const printed = drawn(block);
      state.open.delete(block.key);
      return printed;
    });
    if (lines.length) terminal.print(lines);
    turn = blocks.slice(settled).flatMap(drawn);
    const works = foldedWork(blocks).filter((block) => !state.hidden.has(block.key));
    work = works.length > 0;
    const focused = works.find((block) => block.key === app.attach.focus);
    if (focused) focus = workLine(focused, reader, now, width - 2, ink);
    const entry = state.id ? live?.entry(state.id) : undefined;
    open = threadRequests(reader, {
      title: reader.thread.title,
      project: entry?.workspaceId ?? "",
      provider: reader.thread.provider,
    });
  } else if (state.id)
    turn = [ink.dim(reader?.error ? reader.error.message : "Reading the thread…")];
  terminal.draw(
    attachView(
      app.attach,
      {
        turn,
        request: open?.[0],
        requests: open?.length ?? 0,
        live: activity,
        fresh: state.id === undefined,
        connection: live?.connection(),
        focus,
        work,
      },
      width,
      app.height(),
      ink,
    ),
  );
}
