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

test("a start that takes a moment says Starting ace, and offers a way out once it stalls", () => {
  expect(startupView(run({ type: "slow" }), desktop).message).toBe("Starting ace");
  const stalled = startupView(run({ type: "slow" }, { type: "stalled" }), desktop);
  expect(stalled.message).toBe("Starting ace");
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
    { type: "daemon", state: "failed", message: "EACCES: ~/.ace" },
  );
  const view = startupView(failed, desktop, (reason) => `friendly: ${reason}`);
  expect(view.failure).toBe("friendly: EACCES: ~/.ace");
  expect(view.actions).toEqual(["retry", "logs", "quit"]);
  // The client still trying to connect doesn't hide the failure.
  expect(startupStep(failed, { type: "connection", state: "connecting" }).phase).toBe("failed");
  const retried = startupStep(failed, { type: "retry" });
  expect(startupView(retried, desktop).failure).toBeUndefined();
  expect(startupView(retried, desktop).message).toBe("Starting ace");
});

test("a daemon that restarts on its own after failing clears the failure", () => {
  const back = run(
    { type: "daemon", state: "failed", message: "crashed" },
    { type: "daemon", state: "restarting" },
  );
  expect(startupView(back, desktop).failure).toBeUndefined();
  expect(back.phase).toBe("reconnecting");
});

test("losing the daemon before the app shows says it is reconnecting, then recovers", () => {
  const lost = run({ type: "slow" }, { type: "connection", state: "reconnecting" });
  expect(startupView(lost, desktop).message).toBe("Reconnecting to ace");
  const back = startupStep(lost, { type: "connection", state: "connecting" });
  expect(startupView(back, desktop).message).toBe("Connecting to ace");
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
  expect(startupView(blip, desktop).message).toBe("Opening your threads");
});

test("a screen that takes over (connection form, failure) makes the startup screen leave", () => {
  const view = startupView(run({ type: "slow" }, { type: "handoff" }), desktop);
  expect(view).toMatchObject({ shown: true, leaving: true, actions: [] });
  expect(view.message).toBeUndefined();
});

const daemon = (stage: string, state = "starting"): StartupEvent => ({
  type: "daemon",
  state,
  stage,
});

/** What a desktop window says once the start is slow enough to say anything. */
const saidOnDesktop = (...events: StartupEvent[]) =>
  startupView(
    run({ type: "slow" }, { type: "connection", state: "connecting" }, ...events),
    desktop,
  ).message;
/** The same in a browser, which has only its connection to go on. */
const saidInBrowser = (...events: StartupEvent[]) =>
  startupView(run({ type: "slow" }, ...events), browser).message;

test("the startup screen names the step the desktop's supervisor reports, as it moves", () => {
  const said = saidOnDesktop;
  expect(said(daemon("looking"))).toBe("Looking for ace's background service");
  expect(said(daemon("launching"))).toBe("Starting ace's background service");
  expect(said(daemon("lock-wait"))).toBe("Waiting for the previous ace to close");
  expect(said(daemon("warming"))).toBe("Getting your threads ready");
  // Running: what is left is this page reaching it, then its first data.
  expect(said(daemon("warming"), { type: "daemon", state: "running" })).toBe("Connecting to ace");
  expect(said({ type: "daemon", state: "running" }, { type: "connection", state: "ready" })).toBe(
    "Opening your threads",
  );
});

test("a browser without the desktop bridge still says connecting, starting and opening", () => {
  const said = saidInBrowser;
  expect(said({ type: "connection", state: "connecting" })).toBe("Connecting to ace");
  expect(said({ type: "connection", state: "starting" })).toBe(
    "Waiting for ace to finish starting",
  );
  expect(said({ type: "connection", state: "ready" })).toBe("Opening your threads");
});

test("a step that lasts says so plainly, and a new step starts its own clock", () => {
  const waiting = run({ type: "slow" }, daemon("lock-wait"));
  const long = startupStep(waiting, { type: "long", activity: "lock-wait" });
  expect(startupView(long, desktop).message).toBe(
    "The previous ace is taking a while to close; ace starts as soon as it does",
  );
  const next = startupStep(long, daemon("launching"));
  expect(startupView(next, desktop).message).toBe("Starting ace's background service");
  // A late timer for a step already over changes nothing.
  expect(startupStep(next, { type: "long", activity: "lock-wait" })).toBe(next);
});

test("a crash restart says so through its own steps, and safe mode says what it leaves off", () => {
  const crashed = run(
    { type: "slow" },
    { type: "daemon", state: "restarting", message: "The daemon exited (code 1)" },
    {
      type: "daemon",
      state: "restarting",
      message: "The daemon exited (code 1)",
      stage: "launching",
    },
  );
  expect(startupView(crashed, desktop).message).toBe(
    "ace's background service stopped, so ace is starting it again",
  );
  const safe = startupStep(crashed, {
    type: "daemon",
    state: "restarting",
    message: "ace kept stopping",
    stage: "launching",
    safeMode: true,
  });
  expect(startupView(safe, desktop).message).toBe(
    "ace kept stopping as it started, so it is starting again without the part it was stuck on",
  );
  // A restart the person asked for is just its steps.
  const asked = run({ type: "slow" }, daemon("looking", "restarting"));
  expect(startupView(asked, desktop).message).toBe("Looking for ace's background service");
});

test("the stalled way out still comes at its time whatever step the start is on", () => {
  const stalled = startupView(run(daemon("warming"), { type: "stalled" }), desktop);
  expect(stalled.message).toBe("Getting your threads ready");
  expect(stalled.actions).toEqual(["logs", "restart", "connect"]);
});
