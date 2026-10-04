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
