import {
  macHost,
  macLockedUseInstaller,
  placeholderLockedUseInstaller,
  type LockedUseInstaller,
  type PrivilegedRunner,
  type MacHost,
} from "@ace/screen";

/** CFBundleVersion of the authorization plug-in this ace ships (native/locked-use). */
export const shippedLockedUseBundleVersion = "1";

/** Why installs report unavailable while the privileged step awaits owner review. */
export const pendingPrivilegedReason = "Privileged install pending owner review.";

/** Refuses every change until the owner supplies the reviewed privileged step. */
export const pendingPrivilegedRunner: PrivilegedRunner = {
  install: () => Promise.reject(new Error(pendingPrivilegedReason)),
  remove: () => Promise.reject(new Error("Privileged removal pending owner review.")),
};

/** The pinned Developer ID team; malformed or missing means nothing can be proven valid. */
function pinnedTeam(env: NodeJS.ProcessEnv): string | undefined {
  const team = env.ACE_LOCKED_USE_TEAM?.trim();
  return team && /^[A-Z0-9]{10}$/.test(team) ? team : undefined;
}

/**
 * Locked use on macOS: real read-only detection, with changes going through `runner`.
 * Elsewhere the placeholder, which reports off and refuses changes.
 */
export function daemonLockedUse(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  settings: { get(key: "computer.lockedUse"): Promise<{ value: unknown }> } | undefined;
  host?: MacHost;
  runner?: PrivilegedRunner;
}): LockedUseInstaller {
  if (options.platform !== "darwin") return placeholderLockedUseInstaller(options.platform);
  const settings = options.settings;
  const runner = options.runner ?? pendingPrivilegedRunner;
  return macLockedUseInstaller({
    host: options.host ?? macHost(),
    runner,
    // Without the reviewed privileged step installs can never succeed: report that
    // persistently (instead of off, or needs-approval once the intent is stored) so the row
    // reads as coming soon and never flips on. An install from an earlier build still shows.
    ...(runner === pendingPrivilegedRunner ? { unavailableReason: pendingPrivilegedReason } : {}),
    expect: { bundleVersion: shippedLockedUseBundleVersion, team: pinnedTeam(options.env) },
    readIntent: async () =>
      settings ? (await settings.get("computer.lockedUse")).value === true : false,
    schedule: (intervalMs, tick) => {
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
}
