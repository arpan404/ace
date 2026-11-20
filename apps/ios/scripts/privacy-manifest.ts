/**
 * Apple's required-reason APIs, as they appear in Swift source, and the check that each shipped
 * target's `PrivacyInfo.xcprivacy` declares every one its sources use. App Store Connect rejects
 * an upload whose app or extension binary calls one of these without a declared reason.
 */
export const requiredReasonApis: Record<string, RegExp> = {
  NSPrivacyAccessedAPICategoryUserDefaults: /\bUserDefaults\b|@AppStorage\b/,
  NSPrivacyAccessedAPICategoryFileTimestamp:
    /\battributesOfItem\b|ModificationDate(Key)?\b|\bcreationDate(Key)?\b|\bcontentAccessDateKey\b|\bgetattrlist(at)?\b|\b[fl]?stat(at)?\(/,
  NSPrivacyAccessedAPICategorySystemBootTime: /\bsystemUptime\b|\bmach_absolute_time\b/,
  NSPrivacyAccessedAPICategoryDiskSpace:
    /\bvolumeAvailableCapacity\w*\b|\bvolumeTotalCapacity\w*\b|\bsystemFreeSize\b|\bsystemSize\b|\bstatv?fs\(/,
  NSPrivacyAccessedAPICategoryActiveKeyboards: /\bactiveInputModes\b/,
};

/**
 * The reasons Apple accepts for each category (the "Describing use of required reason API"
 * table). A reason from another category doesn't count, and App Store Connect rejects it.
 */
export const allowedReasons: Record<string, string[]> = {
  NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
  NSPrivacyAccessedAPICategoryFileTimestamp: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
  NSPrivacyAccessedAPICategorySystemBootTime: ["35F9.1", "8FFB.1", "3D61.1"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ["3EC4.1", "54BD.1"],
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

/** Each category a manifest declares, with the reasons it gives. */
export function declaredReasons(manifest: string): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const block of manifest.split("<dict>")) {
    const category = block.match(
      /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>(\w+)<\/string>/,
    )?.[1];
    const list = block.match(
      /<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/,
    )?.[1];
    if (!category || list === undefined) continue;
    const reasons = [...list.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1] ?? "");
    declared.set(category, [...(declared.get(category) ?? []), ...reasons]);
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

/**
 * What's wrong with a target's manifest against its sources: reasons given for the wrong
 * category ("AceShare gives NSPrivacyAccessedAPICategoryUserDefaults reason 35F9.1, which
 * isn't one of its reasons"), then categories used without a reason that counts ("AceShare
 * uses NSPrivacyAccessedAPICategoryUserDefaults (Shared/x.swift) without a reason").
 */
export function undeclared(
  target: string,
  files: { path: string; text: string }[],
  manifest: string | undefined,
): string[] {
  const declared = declaredReasons(manifest ?? "");
  const wrong: string[] = [];
  const counted = new Set<string>();
  for (const [category, reasons] of declared) {
    const allowed = allowedReasons[category];
    if (!allowed) continue;
    for (const reason of reasons) {
      if (allowed.includes(reason)) counted.add(category);
      else
        wrong.push(`${target} gives ${category} reason ${reason}, which isn't one of its reasons`);
    }
  }
  const missing = [...usedCategories(files)]
    .filter(([category]) => !counted.has(category))
    .map(
      ([category, file]) =>
        `${target} uses ${category} (${file}) ${manifest ? "without a reason" : "and has no PrivacyInfo.xcprivacy"}`,
    );
  return [...wrong, ...missing];
}
