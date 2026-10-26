import type { SettingsService } from "@ace/settings";
import {
  macHost,
  macLockedUseInstaller,
  placeholderLockedUseInstaller,
  type LockedUseInstaller,
  type PrivilegedRunner,
} from "@ace/screen";

/** CFBundleVersion of the authorization plug-in this ace ships (native/locked-use). */
export const shippedLockedUseBundleVersion = "1";

/** Refuses every change until the owner supplies the reviewed privileged step. */
export const pendingPrivilegedRunner: PrivilegedRunner = {
  install: () => Promise.reject(new Error("Privileged install pending owner review.")),
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
  settings: Pick<SettingsService, "get"> | undefined;
  runner?: PrivilegedRunner;
}): LockedUseInstaller {
  if (options.platform !== "darwin") return placeholderLockedUseInstaller(options.platform);
  const settings = options.settings;
  return macLockedUseInstaller({
    host: macHost(),
    // Owner supplies the real PrivilegedRunner (authorization-rule + launchd install) after security review.
    runner: options.runner ?? pendingPrivilegedRunner,
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
