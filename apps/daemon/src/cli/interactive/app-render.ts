import type { App } from "./app-context.ts";
import { keepRows } from "./home-cache.ts";
import { homeView, keysLine } from "./home-view.ts";
import { requestsView } from "./requests.ts";
import { agentTree } from "./tree.ts";

/**
 * Draws the current screen (ADR 0178 §9) from the app's state and the live stores: the home
 * (with the last run's rows, unconfirmed, until the live list arrives), the requests walk, or
 * the line saying ace isn't running.
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
  const tree = app.home.open ? live?.followed()?.store : undefined;
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
