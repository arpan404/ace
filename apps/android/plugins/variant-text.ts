/**
 * Pure text transforms for the Ace Android build-variant wiring. This module has no
 * Expo imports so the Gradle and manifest edits stay unit-testable; the thin config
 * plugins in this directory apply these transforms to the prebuilt project.
 */

const BUILD_TYPES_ANCHOR = "    buildTypes {";
const RELEASE_PROGUARD_ANCHOR =
  '            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"';
const MEASUREMENT_MARKER = "Ace measurement build type";
const RELEASE_ENTRY_MARKER = "Ace production bundle entry";

/** Release-like, non-debuggable, profileable fixture build for M01 measurement. */
const MEASUREMENT_BLOCK = `        measurement {
            // ${MEASUREMENT_MARKER}: initWith release keeps minification and shrinking aligned.
            initWith release
            applicationIdSuffix ".measurement"
            profileable true
            matchingFallbacks = ["release"]
        }
`;

function replaceOnce(contents: string, anchor: string, replacement: string, what: string): string {
  const count = contents.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Expected one ${what} anchor, found ${count}.`);
  return contents.replace(anchor, replacement);
}

/**
 * Add the measurement build type and explicitly disable profiling on release.
 * Idempotent; throws when the generated app/build.gradle shape is unexpected.
 */
export function addMeasurementBuildType(appBuildGradle: string): string {
  if (appBuildGradle.includes(MEASUREMENT_MARKER)) return appBuildGradle;
  const withVariant = replaceOnce(
    appBuildGradle,
    BUILD_TYPES_ANCHOR,
    `${BUILD_TYPES_ANCHOR}\n${MEASUREMENT_BLOCK}`,
    "buildTypes",
  );
  return replaceOnce(
    withVariant,
    RELEASE_PROGUARD_ANCHOR,
    `${RELEASE_PROGUARD_ANCHOR}\n            profileable false`,
    "release",
  );
}

/**
 * Pin the production bundle entry and fail the build on unexpected bundle tasks.
 * Idempotent; appended once so plugin reruns never duplicate the guard.
 */
export function pinReleaseBundleEntry(appBuildGradle: string): string {
  if (appBuildGradle.includes(RELEASE_ENTRY_MARKER)) return appBuildGradle;
  const guard = `
// ${RELEASE_ENTRY_MARKER}: release always bundles the fail-closed entry, so a
// fixture or measurement ENTRY_FILE override can never leak into production.
// Any unexpected bundle task fails the build instead of bundling a wrong entry.
afterEvaluate {
    tasks.configureEach { task ->
        if (task.name.startsWith("createBundle") && task.name.endsWith("JsAndAssets")) {
            if (task.name == "createBundleReleaseJsAndAssets") {
                task.entryFile.set(file("$projectDir/../index.production.tsx"))
            } else if (task.name != "createBundleMeasurementJsAndAssets") {
                throw new GradleException("Unexpected Ace bundle task: \${task.name}")
            }
        }
    }
}
`;
  return `${appBuildGradle.endsWith("\n") ? appBuildGradle : `${appBuildGradle}\n`}${guard}`;
}

const LOCKED_DOWN_NETWORK_XML =
  '<network-security-config><base-config cleartextTrafficPermitted="false" /></network-security-config>';
const LOOPBACK_NETWORK_XML =
  '<network-security-config><base-config cleartextTrafficPermitted="false" /><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">localhost</domain><domain includeSubdomains="false">::1</domain></domain-config></network-security-config>';

/** Network policy per source set: only the fixture variants allow loopback cleartext. */
export function variantNetworkXml(variant: "main" | "debug" | "measurement"): string {
  if (variant === "main") return LOCKED_DOWN_NETWORK_XML;
  return LOOPBACK_NETWORK_XML;
}

export function networkXmlDocument(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n${inner}\n`;
}
