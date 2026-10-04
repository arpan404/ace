/** Decode only a single, conventional login-shell wrapper. Never execute the script. */
export function unwrapShellCommand(command: string): { inner: string; shell?: string } | undefined {
  const match =
    /^(\/(?:[^/\s"'\\]+\/)*(?:sh|bash|zsh|dash|fish)) (?:-lc|-c) '((?:[^']|'\\'')*)'$/.exec(
      command,
    );
  const shell = match?.[1];
  const script = match?.[2];
  if (shell === undefined || script === undefined) return undefined;
  return { inner: script.replaceAll("'\\''", "'"), shell };
}
