import { z } from "zod";

/** Decode only a single, conventional login-shell wrapper. Never execute the script. */
export function unwrapShellCommand(command: string): { inner: string; shell: string } | undefined {
  const match =
    /^(\/(?:[A-Za-z0-9_.-]+\/)*(?:sh|bash|zsh|dash|fish)) (?:-lc|-c) '((?:[^']|'\\'')*)'$/.exec(
      command,
    );
  const shell = match?.[1];
  const script = match?.[2];
  if (shell === undefined || script === undefined || match?.[0] !== command) return undefined;
  return { inner: script.replaceAll("'\\''", "'"), shell };
}

const Actions = z.array(z.object({ command: z.string() }).passthrough());
/** Best-effort metadata can corroborate exact executable text, never substitute for it. */
export function commandActionsMatch(command: string, actions: unknown): boolean {
  if (actions === undefined) return true;
  const parsed = Actions.safeParse(actions);
  if (!parsed.success) return false;
  if (parsed.data.length === 0) return true;
  const joined = parsed.data.map((action) => action.command).join(" && ");
  return joined === command || joined === (unwrapShellCommand(command)?.inner ?? command);
}
