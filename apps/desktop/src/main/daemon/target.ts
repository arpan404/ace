import { z } from "zod";
import { SocketUrl } from "../../shared/contract.ts";
import { newerDataMessage } from "./exit-policy.ts";

/** Platforms the daemon runs on locally (its workspace addon is macOS and Linux only). */
const localDaemonPlatforms = new Set<NodeJS.Platform>(["darwin", "linux"]);

/**
 * Which daemon this app talks to:
 * - `managed`: the packaged app's default. Reuse a daemon running in ACE_HOME (CLI, login
 *   service) or start the bundled one, and supervise it.
 * - `attach`: development. Connect to the dev daemon (`bun run daemon`) and never spawn.
 * - `remote`: ACE_DAEMON_URL points at a daemon elsewhere; the token comes from the env.
 * - `fake`: the renderer runs the in-page fake daemon (`dev:desktop:fake`).
 * - `remote-only`: this platform runs no local daemon (Windows today) and no remote one is
 *   configured; the page asks for one.
 * - `refused`: the daemon home can't be used (it holds data from a newer ace, or an older
 *   daemon still runs in a home that needs a fresh start); nothing is spawned and the page
 *   says why.
 *
 * A local target's `home` comes from `@ace/service`'s shared resolver, as the daemon's own
 * does: `~/.ace` unless ACE_HOME selects another. A managed target's home is prepared with the
 * shared `prepareDaemonHome` before anything else writes there (the `ace` command shim
 * included), so a fresh start sets the old data aside first; `fresh` then names the backup.
 */
export type DaemonTarget =
  | { kind: "managed"; home: string; entry: string; fresh?: FreshStart }
  | { kind: "attach"; home: string }
  | { kind: "remote"; url: string; token: string; pairedDeviceId?: string }
  | { kind: "fake" }
  | { kind: "remote-only"; reason: string }
  | { kind: "refused"; reason: string };

/** Where a fresh start put the old home, for the app's log. */
export interface FreshStart {
  backup: string;
  previousFormat: string;
}

/** `resolveDaemonHome` from `@ace/service/home`; injected so tests can use temp homes. */
export type HomeResolver = (home: string, requested?: string) => string;

/** `prepareDaemonHome` from `@ace/service/home`: what it set aside, if it made a fresh start. */
export type HomePreparer = (home: string) => FreshStart | undefined;

const Environment = z.object({
  ACE_HOME: z.string().min(1).optional(),
  ACE_DESKTOP_DAEMON: z.enum(["managed", "attach", "fake"]).optional(),
  ACE_DAEMON_URL: SocketUrl.optional(),
  ACE_DAEMON_DEVICE_ID: z.string().min(1).max(256).optional(),
  ACE_DAEMON_TOKEN: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});

export function resolveTarget(
  env: NodeJS.ProcessEnv,
  options: {
    packaged: boolean;
    daemonEntry: string;
    readToken(path: string): string;
    platform: NodeJS.Platform;
    /** The user's home directory, under which the default daemon home lives. */
    homedir: string;
    resolveHome: HomeResolver;
    prepareHome: HomePreparer;
  },
): DaemonTarget {
  const settings = Environment.parse(env);
  if (settings.ACE_DAEMON_URL) {
    const token =
      settings.ACE_DAEMON_TOKEN ??
      (env.ACE_DAEMON_TOKEN_FILE ? options.readToken(env.ACE_DAEMON_TOKEN_FILE).trim() : "");
    if (!/^[0-9a-f]{64}$/i.test(token))
      throw new Error("ACE_DAEMON_URL needs ACE_DAEMON_TOKEN or ACE_DAEMON_TOKEN_FILE");
    const url = new URL(settings.ACE_DAEMON_URL);
    const pairedDeviceId = settings.ACE_DAEMON_DEVICE_ID;
    if (
      (url.protocol === "wss:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) &&
      !pairedDeviceId
    )
      throw new Error(
        "Remote ACE_DAEMON_URL needs a paired token and ACE_DAEMON_DEVICE_ID. Pair this device first.",
      );
    return {
      kind: "remote",
      url: settings.ACE_DAEMON_URL,
      token: token.toLowerCase(),
      ...(pairedDeviceId ? { pairedDeviceId } : {}),
    };
  }
  const mode = settings.ACE_DESKTOP_DAEMON ?? (options.packaged ? "managed" : "attach");
  if (mode === "fake") return { kind: "fake" };
  // Never try to spawn (or wait for) a local daemon that cannot exist here.
  if (!localDaemonPlatforms.has(options.platform) && settings.ACE_DESKTOP_DAEMON === undefined)
    return {
      kind: "remote-only",
      reason: "ace runs its daemon on macOS and Linux; connect to a daemon on another machine",
    };
  let home: string;
  try {
    home = options.resolveHome(options.homedir, settings.ACE_HOME);
  } catch (error) {
    return { kind: "refused", reason: message(error) };
  }
  // Development's dev daemon prepares its own home; attach never writes there.
  if (mode === "attach") return { kind: "attach", home };
  let fresh: FreshStart | undefined;
  try {
    fresh = options.prepareHome(home);
  } catch (error) {
    // The same words the supervisor uses when a daemon exits on newer data.
    const newer = error instanceof Error && error.name === "NewerDataError";
    return { kind: "refused", reason: newer ? newerDataMessage : message(error) };
  }
  return { kind: "managed", home, entry: options.daemonEntry, ...(fresh ? { fresh } : {}) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
