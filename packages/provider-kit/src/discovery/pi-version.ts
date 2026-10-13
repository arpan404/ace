/**
 * Pi is admitted from the first audited release onward. Newer releases are
 * checked by contract at runtime instead of by an exact allowlist: sessions
 * confirm ace's extension loaded (`get_commands`), auth status parses Pi's
 * `auth check --json` output, and login validates the SDK's `ModelRuntime` shape.
 */
export const piMinimumVersion = "0.85.1";

export function piVersionSupported(version: string | undefined): boolean {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(version?.trim() ?? "");
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major > 0 || minor > 85 || (minor === 85 && patch >= 1);
}

export function piVersionRefusal(version: string | undefined): string {
  return `Pi ${version ?? "with an unknown version"} is not supported; ace supports Pi ${piMinimumVersion} or newer`;
}
