import { join, resolve } from "node:path";
import { z } from "zod";
import { SocketUrl } from "../../shared/contract.ts";

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
 * - `refused`: the daemon home can't be used (an explicit `ACE_HOME` with legacy 0.x data, or
 *   unrecognized data in the isolated home); nothing is spawned and the page says why.
 *
 * A local target's `home` comes from `@ace/service`'s shared resolver, as the daemon's own
 * does: `~/.ace-next` unless ACE_HOME selects an explicit home. `isolated` says the
 * resolver chose the rewrite home separately from legacy `~/.ace`.
 */
export type DaemonTarget =
  | { kind: "managed"; home: string; entry: string; isolated: boolean }
  | { kind: "attach"; home: string; isolated: boolean }
  | { kind: "remote"; url: string; token: string }
  | { kind: "fake" }
  | { kind: "remote-only"; reason: string }
  | { kind: "refused"; reason: string };

/** `resolveDaemonHome` from `@ace/service/home`; injected so tests can use temp homes. */
export type HomeResolver = (home: string, requested?: string) => string;

const Environment = z.object({
  ACE_HOME: z.string().min(1).optional(),
  ACE_DESKTOP_DAEMON: z.enum(["managed", "attach", "fake"]).optional(),
  ACE_DAEMON_URL: SocketUrl.optional(),
  ACE_DAEMON_TOKEN: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});

/** The descriptor addon `@ace/service/home` loads isn't where this run can find it. */
function addonMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND" &&
    error.message.includes("descriptor.node")
  );
}

export function resolveTarget(
  env: NodeJS.ProcessEnv,
  options: {
    packaged: boolean;
    daemonEntry: string;
    readToken(path: string): string;
    platform: NodeJS.Platform;
    /** The user's home directory, under which the default daemon homes live. */
    homedir: string;
    resolveHome: HomeResolver;
  },
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
    // An unpackaged app doesn't ship the shared checks' native addon. Development's attach
    // mode never spawns or starts a service, so it then takes the dev daemon's home as given;
    // any other failure (legacy data in an explicit home) is a refusal.
    if (mode === "attach" && settings.ACE_HOME && !options.packaged && addonMissing(error))
      home = resolve(settings.ACE_HOME);
    else return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
  const isolated =
    settings.ACE_HOME === undefined && home !== join(resolve(options.homedir), ".ace");
  if (mode === "attach") return { kind: "attach", home, isolated };
  return { kind: "managed", home, entry: options.daemonEntry, isolated };
}
