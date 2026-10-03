import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the launcher (src/real-daemon.ts) and the smoke test. */
/** `ACE_E2E_DAEMON_PORT` and `ACE_E2E_DAEMON_HOME` let two checkouts run their e2e side by side. */
export const daemonPort = Number(process.env.ACE_E2E_DAEMON_PORT ?? 4391);
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
