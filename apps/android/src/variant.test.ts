import { expect, it } from "vitest";
import {
  addMeasurementBuildType,
  networkXmlDocument,
  pinReleaseBundleEntry,
  variantNetworkXml,
} from "../plugins/variant-text.ts";

const BUILD_TYPES = `    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }
`;

it("adds a release-like, profileable measurement build type", () => {
  const edited = addMeasurementBuildType(BUILD_TYPES);
  expect(edited).toContain("measurement {");
  expect(edited).toContain("initWith release");
  expect(edited).toContain('applicationIdSuffix ".measurement"');
  expect(edited).toContain("profileable true");
  expect(edited).toContain('matchingFallbacks = ["release"]');
});

it("keeps release non-profileable while measurement stays profileable", () => {
  const edited = addMeasurementBuildType(BUILD_TYPES);
  expect(edited).toContain("profileable false");
  expect(edited.indexOf("profileable false")).toBeGreaterThan(edited.indexOf("measurement {"));
});

it("never duplicates the measurement wiring on plugin reruns", () => {
  const once = addMeasurementBuildType(BUILD_TYPES);
  expect(addMeasurementBuildType(once)).toBe(once);
});

it("refuses a generated build file with an unexpected shape", () => {
  expect(() => addMeasurementBuildType("android { }")).toThrow();
  expect(() => addMeasurementBuildType(`${BUILD_TYPES}\n${BUILD_TYPES}`)).toThrow();
  expect(() => addMeasurementBuildType("    buildTypes {\n    }\n")).toThrow();
});

it("pins the production bundle entry and guards unexpected bundle tasks", () => {
  const edited = pinReleaseBundleEntry("android { }\n");
  expect(edited).toContain("createBundleReleaseJsAndAssets");
  // rootDir is android/, so ../ reaches the app root where the entry lives.
  expect(edited).toContain("$rootDir/../index.production.tsx");
  expect(edited).toContain("createBundleMeasurementJsAndAssets");
  expect(edited).toContain("createBundleDebugJsAndAssets");
  expect(edited).toContain("Unexpected Ace bundle task");
});

it("never duplicates the bundle-entry guard on plugin reruns", () => {
  const once = pinReleaseBundleEntry("android { }\n");
  expect(pinReleaseBundleEntry(once)).toBe(once);
});

it("grants loopback cleartext only to the fixture variants", () => {
  const debug = networkXmlDocument(variantNetworkXml("debug"));
  expect(networkXmlDocument(variantNetworkXml("measurement"))).toBe(debug);
  expect(debug).toContain('cleartextTrafficPermitted="true"');
  expect(debug).toContain("127.0.0.1");
  const main = networkXmlDocument(variantNetworkXml("main"));
  expect(main).not.toContain('cleartextTrafficPermitted="true"');
});
