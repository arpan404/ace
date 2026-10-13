import { expect, test } from "vitest";
import {
  initialStartup,
  startupStep,
  startupView,
  type StartupEvent,
  type StartupState,
} from "./startup-state.ts";

const desktop = { desktop: true, logs: true, connect: true };
const browser = { desktop: false, logs: false, connect: false };
const run = (...events: StartupEvent[]): StartupState => events.reduce(startupStep, initialStartup);

test("a quick start shows only the mark: no words before the wait is noticeable", () => {
  const view = startupView(run({ type: "daemon", state: "starting" }), desktop);
  expect(view).toMatchObject({ shown: true, leaving: false, actions: [] });
  expect(view.message).toBeUndefined();
});

test("a start that takes a moment says Starting ace…, and offers a way out once it stalls", () => {
  expect(startupView(run({ type: "slow" }), desktop).message).toBe("Starting ace…");
  const stalled = startupView(run({ type: "slow" }, { type: "stalled" }), desktop);
  expect(stalled.message).toBe("Starting ace…");
  expect(stalled.actions).toEqual(["logs", "restart", "connect"]);
  // A browser has no daemon to restart: it can reload.
  expect(startupView(run({ type: "stalled" }), browser).actions).toEqual(["reload"]);
});

test("the screen stays up through connecting and only leaves once the app has its first data", () => {
  const connected = run(
    { type: "daemon", state: "running" },
    { type: "connection", state: "connecting" },
    { type: "connection", state: "ready" },
  );
  expect(startupView(connected, desktop)).toMatchObject({ shown: true, leaving: false });
  const ready = startupStep(connected, { type: "data-ready" });
  expect(startupView(ready, desktop)).toMatchObject({ shown: true, leaving: true });
  expect(startupView(startupStep(ready, { type: "left" }), desktop).shown).toBe(false);
});

test("first data arriving before the connection is ready does not lift the screen", () => {
  const early = run({ type: "data-ready" });
  expect(startupView(early, desktop).leaving).toBe(false);
});

test("a daemon that fails says why with Try again and View logs, and Try again starts over", () => {
  const failed = run(
    { type: "daemon", state: "starting" },
    { type: "daemon", state: "failed", message: "EACCES: ~/.ace-next" },
  );
  const view = startupView(failed, desktop, (reason) => `friendly: ${reason}`);
  expect(view.failure).toBe("friendly: EACCES: ~/.ace-next");
  expect(view.actions).toEqual(["retry", "logs", "quit"]);
  // The client still trying to connect doesn't hide the failure.
  expect(startupStep(failed, { type: "connection", state: "connecting" }).phase).toBe("failed");
  const retried = startupStep(failed, { type: "retry" });
  expect(startupView(retried, desktop).failure).toBeUndefined();
  expect(startupView(retried, desktop).message).toBe("Starting ace…");
});

test("a daemon that restarts on its own after failing clears the failure", () => {
  const back = run(
    { type: "daemon", state: "failed", message: "crashed" },
    { type: "daemon", state: "restarting" },
  );
  expect(startupView(back, desktop).failure).toBeUndefined();
  expect(back.phase).toBe("reconnecting");
});

test("losing the daemon before the app shows says Reconnecting…, then recovers", () => {
  const lost = run({ type: "slow" }, { type: "connection", state: "reconnecting" });
  expect(startupView(lost, desktop).message).toBe("Reconnecting…");
  const back = startupStep(lost, { type: "connection", state: "connecting" });
  expect(startupView(back, desktop).message).toBe("Starting ace…");
});

test("once the app is showing, nothing brings the startup screen back", () => {
  const gone = run(
    { type: "connection", state: "ready" },
    { type: "data-ready" },
    { type: "left" },
  );
  for (const event of [
    { type: "daemon", state: "failed", message: "crashed" },
    { type: "connection", state: "reconnecting" },
    { type: "connection", state: "ready" },
    { type: "stalled" },
  ] satisfies StartupEvent[])
    expect(startupView(startupStep(gone, event), desktop).shown).toBe(false);
});

test("a daemon blip while the app loads underneath is the shell's to report, not the screen's", () => {
  const loading = run({ type: "slow" }, { type: "connection", state: "ready" });
  const blip = startupStep(loading, { type: "daemon", state: "restarting" });
  expect(startupView(blip, desktop).message).toBe("Starting ace…");
});

test("a screen that takes over (connection form, failure) makes the startup screen leave", () => {
  const view = startupView(run({ type: "slow" }, { type: "handoff" }), desktop);
  expect(view).toMatchObject({ shown: true, leaving: true, actions: [] });
  expect(view.message).toBeUndefined();
});
