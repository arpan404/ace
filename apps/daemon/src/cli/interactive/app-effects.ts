import { composerOf } from "../tui/composer.ts";
import type { Key } from "../tui/keys.ts";
import { editText, placeWords, runInPlace } from "./actions.ts";
import type { App } from "./app-context.ts";
import { attachedWork, enterAttach, leavingWords, send, slash, unfold } from "./app-attach.ts";
import type { Commands } from "./app-commands.ts";
import { connect, startDaemon } from "./app-daemon.ts";
import { attachKey } from "./attach-model.ts";
import type { Effect } from "./effects.ts";
import { homeKey } from "./home-model.ts";
import { askNewThread } from "./new-thread.ts";
import { requestsKey, requestsStart, threadRequests } from "./requests.ts";

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
  } else if (app.screen === "requests") {
    const next = requestsKey(app.requests, live.requests(), key, app.height() - 6);
    app.requests = next.state;
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
    const next = attachKey(app.attach, open[0], key, app.height() - 8, attachedWork(app));
    app.attach = next.state;
    effects = next.effects;
  }
  app.schedule();
  for (const each of effects) {
    // Daemon round trips report when they land; keys go on meanwhile. Effects that hand the
    // terminal over (prompts, the editor, doctor) hold the next keys until they return.
    if (each.kind === "command" || each.kind === "send" || each.kind === "slash")
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
    case "attach":
      return enterAttach(app, next.threadId);
    case "home":
      app.screen = "home";
      app.live?.follow("attach", undefined);
      app.attached = undefined;
      return app.schedule();
    case "requests":
      app.screen = "requests";
      app.requests = requestsStart;
      return app.schedule();
    case "tree":
      app.live?.follow("tree", next.threadId);
      return app.schedule();
    case "send":
      return send(app, commands, next.text, next.delivery);
    case "slash":
      return slash(app, commands, next.line);
    case "unfold":
      return unfold(app, next.key);
    case "editor":
      app.attach = {
        ...app.attach,
        composer: composerOf(editText(terminal, next.text, app.start.env)),
      };
      return app.schedule();
    case "new-thread": {
      const chosen = await askNewThread(terminal, {
        cwd: process.cwd(),
        projects: app.live?.projects() ?? [],
        defaultProvider: app.live?.defaultProvider(),
      });
      if (chosen) enterAttach(app, undefined, chosen);
      return app.schedule();
    }
    case "place": {
      const words = placeWords(app.start.table, next.place);
      if (!words) return app.flash(`This build of ace can't show ${next.place} here yet.`);
      if (next.place === "market" && words.includes("search")) {
        terminal.suspend();
        const query = await import("../ask.ts")
          .then((ask) =>
            ask.askText("Search the market (ace market search)", "A name, a word, a publisher"),
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
    case "start":
      return;
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
