import { ReleaseVersion } from "@ace/protocol";

/** Rewrite releases must not publish a version that installed-home policy rejects. */
export function installableVersion(value: unknown): string {
  const version = ReleaseVersion.parse(value);
  if (BigInt(version.split(".")[0] ?? "0") === 0n)
    throw new Error("Legacy ace 0.x cannot be installed or published");
  return version;
}
const numeric = (value: string) => /^\d+$/.test(value);
function compareIdentifier(a: string, b: string): number {
  if (a === b) return 0;
  if (numeric(a) && numeric(b)) {
    const x = BigInt(a),
      y = BigInt(b);
    return x === y ? 0 : x > y ? 1 : -1;
  }
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1;
  return a > b ? 1 : -1;
}
/** Numeric base versions and dot-separated prerelease precedence, without float truncation. */
export function isNewer(next: string, current: string): boolean {
  const n = ReleaseVersion.parse(next).split("-", 2);
  const c = ReleaseVersion.parse(current).split("-", 2);
  const coreN = (n[0] ?? "").split("."),
    coreC = (c[0] ?? "").split(".");
  for (let i = 0; i < 3; i++) {
    const order = compareIdentifier(coreN[i] ?? "0", coreC[i] ?? "0");
    if (order !== 0) return order > 0;
  }
  if (n[1] === undefined || c[1] === undefined) return n[1] === undefined && c[1] !== undefined;
  const preN = n[1].split("."),
    preC = c[1].split(".");
  for (let i = 0; i < Math.max(preN.length, preC.length); i++) {
    const a = preN[i],
      b = preC[i];
    if (a === undefined || b === undefined) return a !== undefined;
    const order = compareIdentifier(a, b);
    if (order !== 0) return order > 0;
  }
  return false;
}
