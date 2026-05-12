import { describe, expect, it } from "vitest";
import { buildLegacyClientSettingsMigrationPatch, decodeClientSettingsPatch } from "./useSettings";

describe("decodeClientSettingsPatch", () => {
  it("does not expand partial client patches with default values", () => {
    expect(decodeClientSettingsPatch({ confirmThreadArchive: true })).toEqual({
      confirmThreadArchive: true,
    });
  });

  it("preserves independent client setting keys in the same patch", () => {
    expect(
      decodeClientSettingsPatch({
        commentSubmissionMode: "accumulate",
        confirmThreadDelete: false,
      }),
    ).toEqual({
      commentSubmissionMode: "accumulate",
      confirmThreadDelete: false,
    });
  });
});

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });
});
