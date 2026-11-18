import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { releasePlan, timestampBuildNumber } from "./release-plan.ts";

const root = "/repo/apps/ios";
const nowMs = Date.UTC(2026, 10, 17, 20, 5);
const key = {
  APPLE_API_KEY: "/keys/AuthKey_ABC.p8",
  APPLE_API_KEY_ID: "ABC123",
  APPLE_API_ISSUER: "issuer-uuid",
};
const plan = (argv: string[], env: Record<string, string>) =>
  releasePlan({ argv, env, root, nowMs });
/** The value after `flag` in an argument list. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("uploading to App Store Connect", () => {
  test("archives signed with the team and key, then exports straight to App Store Connect", () => {
    const upload = plan(["--upload"], { ACE_IOS_TEAM_ID: "TEAM123456", ...key });
    expect(upload.archiveArgs).toEqual(
      expect.arrayContaining([
        "archive",
        "DEVELOPMENT_TEAM=TEAM123456",
        "CODE_SIGN_STYLE=Automatic",
        "-allowProvisioningUpdates",
      ]),
    );
    expect(after(upload.archiveArgs, "-authenticationKeyPath")).toBe(key.APPLE_API_KEY);
    expect(upload.upload?.args[0]).toBe("-exportArchive");
    expect(after(upload.upload?.args ?? [], "-authenticationKeyID")).toBe("ABC123");
    expect(upload.upload?.options).toContain("<string>app-store-connect</string>");
    expect(upload.upload?.options).toContain("<key>destination</key>\n  <string>upload</string>");
    expect(upload.upload?.options).toContain("<string>TEAM123456</string>");
  });

  test("turns remote push on unless ACE_PUSH turns it off", () => {
    const env = { ACE_IOS_TEAM_ID: "TEAM123456", ...key };
    expect(plan(["--upload"], env).archiveArgs).toContain("ACE_PUSH=YES");
    expect(plan(["--upload"], { ...env, ACE_PUSH: "no" }).archiveArgs).toContain("ACE_PUSH=NO");
  });

  test("numbers the build from the UTC time, so every upload is higher than the last", () => {
    const upload = plan(["--upload"], { ACE_IOS_TEAM_ID: "TEAM123456", ...key });
    expect(upload.buildNumber).toBe("202611172005");
    expect(upload.archiveArgs).toContain("CURRENT_PROJECT_VERSION=202611172005");
    expect(Number(timestampBuildNumber(nowMs + 60_000))).toBeGreaterThan(
      Number(timestampBuildNumber(nowMs)),
    );
  });

  test("takes the version from a release tag and a build number when given", () => {
    const upload = plan(["--upload"], {
      ACE_IOS_TEAM_ID: "TEAM123456",
      ACE_IOS_VERSION: "ios-v1.2.0",
      ACE_IOS_BUILD_NUMBER: "42",
      ...key,
    });
    expect(upload.archiveArgs).toEqual(
      expect.arrayContaining(["MARKETING_VERSION=1.2.0", "CURRENT_PROJECT_VERSION=42"]),
    );
  });

  test.each([
    ["no team", { ...key }, /ACE_IOS_TEAM_ID/],
    ["no API key", { ACE_IOS_TEAM_ID: "TEAM123456" }, /App Store Connect API key/],
    [
      "part of an API key",
      { ACE_IOS_TEAM_ID: "TEAM123456", APPLE_API_KEY: "/k.p8" },
      /all of APPLE_API_KEY/,
    ],
    [
      "a version that isn't one",
      { ACE_IOS_TEAM_ID: "TEAM123456", ACE_IOS_VERSION: "next", ...key },
      /ACE_IOS_VERSION/,
    ],
    [
      "a build number that isn't a number",
      { ACE_IOS_TEAM_ID: "TEAM123456", ACE_IOS_BUILD_NUMBER: "1.0", ...key },
      /ACE_IOS_BUILD_NUMBER/,
    ],
  ])("refuses to start with %s", (_, env, message) => {
    expect(() => plan(["--upload"], env)).toThrow(message);
  });

  test.skipIf(process.platform !== "darwin")("writes export options plutil accepts", () => {
    const upload = plan(["--upload"], { ACE_IOS_TEAM_ID: "TEAM123456", ...key });
    const file = join(mkdtempSync(join(tmpdir(), "ace-export-")), "ExportOptions.plist");
    writeFileSync(file, upload.upload?.options ?? "");
    const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });
});

describe("archiving without uploading", () => {
  test("an unsigned archive turns signing and push off and needs no team", () => {
    const unsigned = plan(["--unsigned"], {});
    expect(unsigned.archiveArgs).toEqual(
      expect.arrayContaining(["CODE_SIGNING_ALLOWED=NO", "ACE_PUSH=NO"]),
    );
    expect(unsigned.archiveArgs).not.toContain("-allowProvisioningUpdates");
    expect(unsigned.upload).toBeUndefined();
  });

  test("a signed archive keeps push off and the build number at 1 unless asked", () => {
    const signed = plan([], { ACE_IOS_TEAM_ID: "TEAM123456" });
    expect(signed.archiveArgs).toEqual(
      expect.arrayContaining(["ACE_PUSH=NO", "CURRENT_PROJECT_VERSION=1"]),
    );
    expect(signed.upload).toBeUndefined();
  });

  test("--unsigned and --upload together are refused", () => {
    expect(() => plan(["--unsigned", "--upload"], { ACE_IOS_TEAM_ID: "T", ...key })).toThrow();
  });
});
