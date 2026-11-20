/**
 * Apple's required-reason APIs, as they appear in Swift source, and the check that each shipped
 * target's `PrivacyInfo.xcprivacy` declares every one its sources use. App Store Connect rejects
 * an upload whose app or extension binary calls one of these without a declared reason.
 */
export const requiredReasonApis: Record<string, RegExp> = {
  NSPrivacyAccessedAPICategoryUserDefaults: /\bUserDefaults\b|@AppStorage\b/,
  NSPrivacyAccessedAPICategoryFileTimestamp:
    /\battributesOfItem\b|\b(content)?ModificationDate(Key)?\b|\bcreationDateKey\b|\bcontentAccessDateKey\b|\bgetattrlist\b|\b[fl]?stat\(/,
  NSPrivacyAccessedAPICategorySystemBootTime: /\bsystemUptime\b|\bmach_absolute_time\b/,
  NSPrivacyAccessedAPICategoryDiskSpace:
    /\bvolumeAvailableCapacity\w*\b|\bvolumeTotalCapacity\w*\b|\bsystemFreeSize\b|\bsystemSize\b|\bstatv?fs\(/,
  NSPrivacyAccessedAPICategoryActiveKeyboards: /\bactiveInputModes\b/,
};

export type Target = { name: string; type: string; sources: string[] };

/** The targets in an XcodeGen `project.yml`, with their source paths, read line by line. */
export function targetsOf(projectYml: string): Target[] {
  const targets: Target[] = [];
  let inTargets = false;
  let inSources = false;
  for (const line of projectYml.split("\n")) {
    if (/^\S/.test(line)) inTargets = line.startsWith("targets:");
    if (!inTargets) continue;
    const name = line.match(/^ {2}(\w+):\s*$/)?.[1];
    if (name) {
      targets.push({ name, type: "", sources: [] });
      inSources = false;
      continue;
    }
    const target = targets.at(-1);
    if (!target) continue;
    const type = line.match(/^ {4}type:\s*(\S+)/)?.[1];
    if (type) target.type = type;
    if (/^ {4}\w/.test(line)) inSources = /^ {4}sources:/.test(line);
    const path = inSources ? line.match(/^ {6}- path:\s*(\S+)/)?.[1] : undefined;
    if (path) target.sources.push(path);
  }
  return targets;
}

/** The API categories a manifest declares with at least one reason. */
export function declaredCategories(manifest: string): Set<string> {
  const declared = new Set<string>();
  for (const block of manifest.split("<dict>")) {
    const category = block.match(
      /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>(\w+)<\/string>/,
    )?.[1];
    const reasons = block.match(/<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>\s*<string>/);
    if (category && reasons) declared.add(category);
  }
  return declared;
}

/** The categories a target's sources use, each with the first file that uses it. */
export function usedCategories(files: { path: string; text: string }[]): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of files) {
    for (const [category, pattern] of Object.entries(requiredReasonApis)) {
      if (!used.has(category) && pattern.test(file.text)) used.set(category, file.path);
    }
  }
  return used;
}

/** "AceShare uses NSPrivacyAccessedAPICategoryUserDefaults (Shared/x.swift) without a reason". */
export function undeclared(
  target: string,
  files: { path: string; text: string }[],
  manifest: string | undefined,
): string[] {
  const declared = declaredCategories(manifest ?? "");
  return [...usedCategories(files)]
    .filter(([category]) => !declared.has(category))
    .map(
      ([category, file]) =>
        `${target} uses ${category} (${file}) ${manifest ? "without a reason" : "and has no PrivacyInfo.xcprivacy"}`,
    );
}
