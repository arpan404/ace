import type { Key } from "../tui/keys.ts";
import { placeWords, runInPlace } from "./actions.ts";
import { leavingWords, type App } from "./app-context.ts";
import type { Commands } from "./app-commands.ts";
import { connect, startDaemon } from "./app-daemon.ts";
import type { Effect } from "./effects.ts";
import { homeKey } from "./home-model.ts";
import { requestsKey, requestsStart } from "./requests.ts";

/**
 * Keys to the current screen's model, and the effects the models ask for, carried out against
 * the daemon and the terminal (ADR 0178 §9).
 */
export async function onKey(app: App, commands: Commands, key: Key): Promise<void> {
  if (app.screen === "offline") return offlineKey(app, key);
  const live = app.live;
  if (!live) return;
  let effects: readonly Effect[] = [];
  if (app.screen === "home") {
    const next = homeKey(app.home, live.rows(Date.now()), key);
    app.home = next.state;
    effects = next.effects;
  } else {
    const next = requestsKey(app.requests, live.requests(), key, app.height() - 6);
    app.requests = next.state;
    effects = next.effects;
  }
  app.schedule();
  for (const each of effects) {
    // Daemon round trips report when they land; keys go on meanwhile. Effects that hand the
    // terminal over (prompts, doctor, thread show) hold the next keys until they return.
    if (each.kind === "command")
      void effect(app, commands, each).catch((error: unknown) =>
        app.flash(error instanceof Error ? error.message : String(error)),
      );
    else await effect(app, commands, each);
  }
}

async function effect(app: App, commands: Commands, next: Effect): Promise<void> {
  const { terminal } = app;
  switch (next.kind) {
    case "quit":
      return app.quit(next.farewell || leavingWords(app), next.code);
    case "command":
      return commands.submit(next.payload, next.done);
    case "home":
      app.screen = "home";
      return app.schedule();
    case "requests":
      app.screen = "requests";
      app.requests = requestsStart;
      return app.schedule();
    case "tree":
      app.live?.follow(next.threadId);
      return app.schedule();
    case "thread-show":
      await runInPlace(terminal, ["thread", "show", next.threadId]);
      return app.schedule();
    case "place": {
      const words = placeWords(app.start.table, next.place);
      if (!words) return app.flash(`This build of ace can't show ${next.place} here yet.`);
      if (next.place === "market" && words.includes("search")) {
        terminal.suspend();
        const query = await import("../ask.ts")
          .then((ask) =>
            ask.askText("Search the Store (ace store search)", "A name, a word, a publisher"),
          )
          .catch(() => undefined);
        terminal.resume();
        if (!query) return app.schedule();
        words.push(query);
      }
      await runInPlace(terminal, words);
      return app.schedule();
    }
    case "doctor":
      await runInPlace(terminal, ["doctor"]);
      return app.schedule();
    case "triage":
      await runInPlace(terminal, ["triage"]);
      return app.schedule();
  }
}

async function offlineKey(app: App, key: Key): Promise<void> {
  const char = key.name === "char" && !key.ctrl ? key.text : undefined;
  if (char === "q" || (key.ctrl && key.text === "c"))
    return app.quit(leavingWords(app), key.ctrl ? 130 : 0);
  if (char === "d") await runInPlace(app.terminal, ["doctor"]);
  if (char === "t") await runInPlace(app.terminal, ["triage"]);
  if (char === "s") {
    try {
      await startDaemon(app);
      if (await connect(app)) app.screen = "home";
    } catch (error) {
      app.terminal.print([
        error instanceof Error ? error.message : "ace didn't start. Try ace doctor.",
      ]);
    }
  }
  app.schedule();
}
