import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SocketUrl } from "../../shared/contract.ts";

/**
 * Which daemon this app talks to:
 * - `managed`: the packaged app's default. Reuse a daemon running in ACE_HOME (CLI, login
 *   service) or start the bundled one, and supervise it.
 * - `attach`: development. Connect to the dev daemon (`bun run daemon`) and never spawn.
 * - `remote`: ACE_DAEMON_URL points at a daemon elsewhere; the token comes from the env.
 * - `fake`: the renderer runs the in-page fake daemon (`dev:desktop:fake`).
 */
export type DaemonTarget =
  | { kind: "managed"; home: string; entry: string }
  | { kind: "attach"; home: string }
  | { kind: "remote"; url: string; token: string }
  | { kind: "fake" };

const Environment = z.object({
  ACE_HOME: z.string().min(1).optional(),
  ACE_DESKTOP_DAEMON: z.enum(["managed", "attach", "fake"]).optional(),
  ACE_DAEMON_URL: SocketUrl.optional(),
  ACE_DAEMON_TOKEN: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});

export function resolveTarget(
  env: NodeJS.ProcessEnv,
  options: { packaged: boolean; daemonEntry: string; readToken(path: string): string },
): DaemonTarget {
  const settings = Environment.parse(env);
  if (settings.ACE_DAEMON_URL) {
    const token =
      settings.ACE_DAEMON_TOKEN ??
      (env.ACE_DAEMON_TOKEN_FILE ? options.readToken(env.ACE_DAEMON_TOKEN_FILE).trim() : "");
    if (!/^[0-9a-f]{64}$/i.test(token))
      throw new Error("ACE_DAEMON_URL needs ACE_DAEMON_TOKEN or ACE_DAEMON_TOKEN_FILE");
    return { kind: "remote", url: settings.ACE_DAEMON_URL, token: token.toLowerCase() };
  }
  const home = settings.ACE_HOME ?? join(homedir(), ".ace");
  const mode = settings.ACE_DESKTOP_DAEMON ?? (options.packaged ? "managed" : "attach");
  if (mode === "fake") return { kind: "fake" };
  if (mode === "attach") return { kind: "attach", home };
  return { kind: "managed", home, entry: options.daemonEntry };
}
