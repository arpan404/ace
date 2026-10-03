import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the launcher (src/real-daemon.ts) and the smoke test. */
export const daemonPort = 4391;
export const daemonHome = join(tmpdir(), "ace-web-e2e-daemon");
export const daemonTokenPath = join(daemonHome, "daemon-token");
export const workspaceName = "e2e-project";
export const seededTitle = "Smoke test on a real daemon";
export const scriptedReply = "Hello from the scripted provider.";
