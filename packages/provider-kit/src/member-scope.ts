/*
 * Starting a member's provider process inside their containment on an org host (ADR 0209 §7.3).
 * The daemon names the member tree's systemd slice in the session's environment; every owned spawn
 * then starts through `systemd-run --user --scope` under that slice, which execs the command only
 * once the scope exists, so the process and all it starts are inside before any of its code runs.
 * When the scope can't be made, systemd-run exits without running the command: the spawn fails
 * and nothing runs uncontained. Needs systemd 254 or later (`--expand-environment`); an older
 * one refuses the option, which fails closed the same way.
 */

/** The environment entry naming the slice; never passed on to the process itself. */
export const MEMBER_SLICE_ENV = "ACE_MEMBER_SLICE";
const slicePattern = /^ace-member-[0-9a-f]{24}-[0-9a-f]{24}\.slice$/;

/**
 * The command to spawn for `command` under `env`: unchanged without a slice; through
 * systemd-run with one. A slice named anywhere but Linux, or malformed, is refused.
 */
export function memberScopedCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const slice = env[MEMBER_SLICE_ENV];
  if (slice === undefined || slice === "") return { command, args: [...args] };
  if (platform !== "linux" || !slicePattern.test(slice))
    throw new Error("This process must run inside its member's containment, which isn't here.");
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      // The command line exactly as given: systemd would otherwise expand `$` in it.
      "--expand-environment=no",
      `--slice=${slice}`,
      "--property=Delegate=no",
      "--",
      command,
      ...args,
    ],
  };
}

/** `env` without the slice entry, for the process itself. */
export function withoutMemberSlice(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!(MEMBER_SLICE_ENV in env)) return env;
  const { [MEMBER_SLICE_ENV]: _slice, ...rest } = env;
  return rest;
}
