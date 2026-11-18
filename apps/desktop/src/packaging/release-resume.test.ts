import { describe, expect, it } from "vitest";
import type { StagedRelease } from "./release-plan.ts";
import {
  conflictingAssets,
  publishVerdict,
  releasePlatforms,
  resumePlan,
  type ReleaseAsset,
  type ReleasePlatform,
} from "./release-resume.ts";

const commit = "a".repeat(40);
const hash = (n: number) => n.toString(16).padStart(64, "0");
const data = { name: "ace-data.json", bytes: 40, sha256: hash(99) };

function staged(platform: ReleasePlatform, overrides: Partial<StagedRelease> = {}): StagedRelease {
  return {
    version: "0.0.24",
    tag: "v0.0.24",
    commit,
    dirty: false,
    signed: platform === "darwin-arm64",
    notarized: platform === "darwin-arm64",
    files: [
      {
        name: `ace-0.0.24-${platform}.pkg`,
        bytes: 10,
        sha256: hash(releasePlatforms.indexOf(platform)),
      },
      data,
    ],
    ...overrides,
  };
}

const uploaded = (release: StagedRelease): ReleaseAsset[] =>
  release.files.map((file) => ({
    name: file.name,
    size: file.bytes,
    digest: `sha256:${file.sha256}`,
  }));

const all = new Map(releasePlatforms.map((platform) => [platform, staged(platform)]));
const allAssets = [...all.values()].flatMap(uploaded);

describe("what a release run builds", () => {
  it("builds every platform for a tag with no release yet", () => {
    expect(resumePlan({ state: { exists: false }, commit, manifests: new Map() })).toEqual({
      published: false,
      build: [...releasePlatforms],
    });
  });

  it("skips platforms whose files are all on the draft from the tag's commit", () => {
    const manifests = new Map([["darwin-arm64", staged("darwin-arm64")]] as const);
    const plan = resumePlan({
      state: { exists: true, draft: true, body: "", assets: uploaded(staged("darwin-arm64")) },
      commit,
      manifests,
    });
    expect(plan.build).toEqual(["linux-x64", "linux-arm64", "win32-x64"]);
  });

  it("rebuilds a platform whose upload stopped halfway", () => {
    const mac = staged("darwin-arm64");
    const plan = resumePlan({
      state: { exists: true, draft: true, body: "", assets: uploaded(mac).slice(1) },
      commit,
      manifests: new Map([["darwin-arm64", mac]]),
    });
    expect(plan.build).toContain("darwin-arm64");
  });

  it("rebuilds a platform uploaded from another commit", () => {
    const old = staged("linux-x64", { commit: "b".repeat(40) });
    const plan = resumePlan({
      state: { exists: true, draft: true, body: "", assets: uploaded(old) },
      commit,
      manifests: new Map([["linux-x64", old]]),
    });
    expect(plan.build).toContain("linux-x64");
  });

  it("does nothing more once the release is published", () => {
    const plan = resumePlan({
      state: { exists: true, draft: false, body: "", assets: [] },
      commit,
      manifests: new Map(),
    });
    expect(plan).toEqual({ published: true, build: [] });
  });
});

describe("whether a draft can go live", () => {
  const verdict = (manifests: ReadonlyMap<ReleasePlatform, StagedRelease>, assets = allAssets) =>
    publishVerdict({ assets, commit, version: "0.0.24", manifests });

  it("publishes every platform's files with one SHA256SUMS listing ace-data.json once", () => {
    const result = verdict(all);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.release.files).toHaveLength(5);
    expect(result.checksums.match(/ace-data\.json/g)).toHaveLength(1);
  });

  it("waits for a platform that hasn't uploaded", () => {
    const partial = new Map(all);
    partial.delete("win32-x64");
    expect(verdict(partial)).toEqual({ ok: false, problems: ["No build uploaded for win32-x64"] });
  });

  it("refuses builds of different commits", () => {
    const mixed = new Map(all).set(
      "linux-arm64",
      staged("linux-arm64", { commit: "c".repeat(40) }),
    );
    expect(verdict(mixed)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/linux-arm64 was built from cccccccccccc/)],
    });
  });

  it("refuses an unsigned macOS build", () => {
    const unsigned = new Map(all).set("darwin-arm64", staged("darwin-arm64", { notarized: false }));
    expect(verdict(unsigned)).toMatchObject({
      ok: false,
      problems: ["The macOS build isn't signed and notarized"],
    });
  });

  it("refuses when an uploaded file's bytes differ from the build's", () => {
    const tampered = allAssets.map((asset) =>
      asset.name === "ace-0.0.24-linux-x64.pkg" ? { ...asset, digest: `sha256:${hash(7)}` } : asset,
    );
    expect(verdict(all, tampered)).toEqual({
      ok: false,
      problems: ["Not on the draft: ace-0.0.24-linux-x64.pkg"],
    });
  });
});

describe("uploading a host's files to the draft", () => {
  it("flags a file the draft already holds with other bytes, not one it lacks or holds unchanged", () => {
    const mac = staged("darwin-arm64");
    const assets = [{ name: "ace-data.json", size: 40, digest: `sha256:${hash(5)}` }];
    expect(conflictingAssets(assets, mac)).toEqual(["ace-data.json"]);
    expect(conflictingAssets(uploaded(mac), mac)).toEqual([]);
  });
});
