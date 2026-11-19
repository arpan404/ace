/**
 * Chromium keeps only the last occurrence of a switch, so a second `--disable-features` replaces
 * the first, and a bare one (no value) clears it. Every occurrence in `args` becomes one flag
 * listing each feature once, at the first occurrence's place; nothing else moves.
 */
export function mergeDisabledFeatures(args: readonly string[]): string[] {
  const switchPattern = /^--?disable-features(?:=(.*))?$/s;
  const features: string[] = [];
  let at = -1;
  const rest: string[] = [];
  for (const arg of args) {
    const match = switchPattern.exec(arg);
    if (!match) {
      rest.push(arg);
      continue;
    }
    if (at === -1) at = rest.length;
    for (const feature of (match[1] ?? "").split(","))
      if (feature !== "" && !features.includes(feature)) features.push(feature);
  }
  if (at === -1) return rest;
  // Only bare switches: no flag at all disables the same nothing without clearing anything.
  if (features.length === 0) return rest;
  return [...rest.slice(0, at), `--disable-features=${features.join(",")}`, ...rest.slice(at)];
}
