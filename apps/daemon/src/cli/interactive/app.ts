import { useColor } from "../input-mode.ts";
import { paint } from "../tui/paint.ts";
import { openTerminal } from "../tui/terminal.ts";
import { words, type App, type AppStart } from "./app-context.ts";
import { enterAttach, leavingWords } from "./app-attach.ts";
import { commands as openCommands } from "./app-commands.ts";
import { connect, isOffline } from "./app-daemon.ts";
import { onKey } from "./app-effects.ts";
import { keepLive, render } from "./app-render.ts";
import { attachStart } from "./attach-model.ts";
import { homeStart } from "./home-state.ts";
import { requestsStart } from "./requests.ts";

/**
 * The interactive shell (ADR 0176 §9): one terminal, one connection, and the home, requests
 * and attach views over the client's stores. Models and views are pure; this wires the
 * terminal's keys, resizes and signals to them, connects, and gives the terminal back.
 */
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
  // The home's first frame (its kept rows) is already up when the home opened the terminal.
  if (!start.terminal) terminal.draw({ lines: [`ace  ${ink.dim("Connecting…")}`] });
  let finished: ((farewell: string) => void) | undefined;
  const done = new Promise<string>((resolve) => {
    finished = resolve;
  });
  let leaving = false;
  // Redraws coalesce: a burst of store changes is one frame.
  let redraw: ReturnType<typeof setTimeout> | undefined;
  const app: App = {
    start,
    terminal,
    ink,
    screen: "home",
    home: homeStart,
    requests: requestsStart,
    attach: attachStart,
    attached: undefined,
    session: undefined,
    live: undefined,
    kept: false,
    schedule: () => {
      redraw ??= setTimeout(() => {
        redraw = undefined;
        draw();
      }, 16);
    },
    flash: (text) => {
      if (app.screen === "attach") app.attach = { ...app.attach, notice: text };
      else if (app.screen === "requests") app.requests = { ...app.requests, notice: text };
      else app.home = { ...app.home, notice: text };
      app.schedule();
    },
    quit: (farewell, code) => {
      if (leaving) return;
      leaving = true;
      if (code) process.exitCode = code;
      finished?.(farewell);
    },
    width: () => terminal.columns - 1,
    height: () => terminal.rows - 1,
  };
  const commands = openCommands(app);
  const draw = () => {
    commands.check();
    render(app);
  };
  const ticker = setInterval(() => app.schedule(), 1000);
  ticker.unref();

  // Keys run one after another, so a burst of typing is never dropped or reordered.
  let keys = Promise.resolve();
  const stopKeys = terminal.onKey((key) => {
    keys = keys
      .then(() => onKey(app, commands, key))
      .catch((error: unknown) => app.flash(words(error)))
      .finally(app.schedule);
  });
  const stopResize = terminal.onResize(draw);
  const stopSignal = terminal.onSignal((signal) =>
    app.quit(leavingWords(app), signal === "SIGINT" ? 130 : 143),
  );
  let message = "";
  try {
    try {
      if (!(await connect(app))) app.screen = "offline";
      else if (start.attach) {
        const fresh = start.attach.fresh;
        enterAttach(
          app,
          start.attach.threadId,
          fresh && {
            project: fresh.project ?? process.cwd(),
            provider: fresh.provider ?? app.live?.defaultProvider() ?? "codex",
            model: fresh.model,
          },
        );
      }
    } catch (error) {
      if (!isOffline(error)) throw error;
      app.screen = "offline";
    }
    draw();
    message = await done;
  } finally {
    clearInterval(ticker);
    if (redraw) clearTimeout(redraw);
    stopKeys();
    stopResize();
    stopSignal();
    commands.close();
    keepLive(app);
    app.live?.close();
    terminal.close(message || undefined);
    await app.session?.close().catch(() => {});
  }
}
