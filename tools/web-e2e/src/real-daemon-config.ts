import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the launcher (src/real-daemon.ts) and the smoke test. */
/** `ACE_E2E_DAEMON_PORT` and `ACE_E2E_DAEMON_HOME` let two checkouts run their e2e side by side. */
export const daemonPort = Number(process.env.ACE_E2E_DAEMON_PORT ?? 4391);
/**
 * The real-daemon project's Vite server; the daemon allows its origin on the access routes.
 * `ACE_E2E_WEB_PORT` (and `ACE_E2E_FAKE_PORT` for the fake one) let checkouts run side by side.
 */
export const webPort = Number(process.env.ACE_E2E_WEB_PORT ?? 5191);
export const webOrigin = `http://127.0.0.1:${webPort}`;
/** A phone paired before the run, so the remote settings journey can list and revoke it. */
export const pairedDeviceName = "E2E phone";
export const daemonHome = join(tmpdir(), process.env.ACE_E2E_DAEMON_HOME ?? "ace-web-e2e-daemon");
export const daemonTokenPath = join(daemonHome, "daemon-token");
export const workspaceName = "e2e-project";
export const seededTitle = "Smoke test on a real daemon";
/** A second thread for the per-screen spec, so each spec counts replies in its own thread. */
export const screensTitle = "Screens on a real daemon";
/** The worker spec's own thread, so its sends never change another spec's reply count. */
export const workerTitle = "Shared worker on a real daemon";
export const scriptedReply = "Hello from the scripted provider.";
/** The workspace spec's thread: runs a project script, opens a terminal and commits. */
export const workspaceTitle = "Workspace actions on a real daemon";
/** What the project's `greet` script prints when the Run button starts it. */
export const scriptOutput = "ace e2e script ran";
/** A local git repository with a plugin marketplace, for installing a plugin end to end. */
export const pluginMarketPath = join(daemonHome, "plugin-market");
export const pluginName = "e2e-tools";
/** A message carrying this keeps its turn working until the person steers into it or stops it. */
export const holdMarker = "[hold]";
/** A message carrying this runs into the scripted account's usage limit. */
export const limitMarker = "[limit]";
export const limitNotice = "You've hit your usage limit for this window.";
/** The organization spec's threads, one per journey so they can run side by side. */
export const settleTitle = "Settle on a real daemon";
export const snoozeTitle = "Snooze on a real daemon";
export const forkTitle = "Fork on a real daemon";
export const deleteTitle = "Delete on a real daemon";
/** The queue spec's thread: a held turn, a queued message and Send now. */
export const queueTitle = "Queue on a real daemon";
/** The limit spec's thread: a usage limit and resuming from it. */
export const limitTitle = "Limit on a real daemon";
/** The preview spec's thread. */
export const previewTitle = "Preview on a real daemon";
/** A Deck goal carrying this makes its first card's worker ask the person before it works. */
export const deckAskMarker = "[ask]";
export const deckQuestion = "Should the health note live at the project root?";
/**
 * How long a scripted Deck lane works before it answers, so a journey sees cards working rather
 * than jumping straight to merged. `ACE_E2E_DECK_STEP_MS` overrides it.
 */
export const deckStepMs = Number(process.env.ACE_E2E_DECK_STEP_MS ?? 700);
/**
 * The long-thread journey's thread: this many turns, each "Checkpoint N" with a word only that
 * turn has (search finds exactly one), well past the daemon's 200-item snapshot.
 */
export const longTitle = "Long thread on a real daemon";
export const longTurns = Number(process.env.ACE_E2E_LONG_TURNS ?? 110);
export const longAsk = (n: number) => `Checkpoint ${n}: audit migration shard alpha${n}x.`;
/**
 * Where the project journeys add, create and clone projects: the daemon's only allowed root.
 * Outside the system temp directory on macOS, whose real path sits under /private/var, a
 * folder the daemon never opens.
 */
export const projectsRoot = join(
  process.platform === "win32" ? tmpdir() : "/tmp",
  `${process.env.ACE_E2E_DAEMON_HOME ?? "ace-web-e2e-daemon"}-projects`,
);
/** A folder already in the root, for Open folder. */
export const existingFolder = "proj-existing";
/** A folder for the deep link journey. */
export const linkedFolder = "proj-linked";
/**
 * The address the clone journey clones. Git rewrites it to a local bare repository (the
 * daemon home's global Git config), so no network is used; ace's client checks see a normal
 * HTTPS address.
 */
export const cloneUrl = "https://git.e2e.invalid/sample.git";
/** A file the cloned repository holds. */
export const clonedFile = "SAMPLE.md";
