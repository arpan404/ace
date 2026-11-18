import { describe, expect, it } from "vitest";
import {
  neverDeployed,
  parseDeployment,
  parseVersion,
  releaseFor,
  smokeOrigins,
} from "./release.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("release identity", () => {
  it("carries the tag and the full commit in the version message", () => {
    expect(releaseFor("v1.4.0", commit)).toEqual({
      tag: "v1.4.0",
      commit,
      message: `ace v1.4.0 (${commit})`,
    });
  });

  it("names an untagged release after its commit", () => {
    expect(releaseFor(undefined, commit).tag).toBe("git-0123456789ab");
  });

  it.each([["v1.0 beta"], ["--version"], [""]])("refuses the tag %j", (tag) => {
    expect(() => releaseFor(tag, commit)).toThrow();
  });

  it("refuses an abbreviated commit, so a release can't match another commit's", () => {
    expect(() => releaseFor("v1.0.0", "0123456")).toThrow();
  });
});

describe("smoke origins", () => {
  it("smokes every custom domain and nothing else", () => {
    expect(
      smokeOrigins([
        { pattern: "cloud.acehq.dev", custom_domain: true },
        { pattern: "relay.acehq.dev", custom_domain: true },
        { pattern: "acehq.dev/old/*" },
        "example.com/*",
      ]),
    ).toEqual(["https://cloud.acehq.dev", "https://relay.acehq.dev"]);
  });
});

describe("reading wrangler's output", () => {
  it("finds the deployment's versions past a warning wrangler printed first", () => {
    const output = `▲ [WARNING] Processing wrangler.jsonc\n{"id":"d1","versions":[{"version_id":"v9","percentage":100}],"annotations":{}}\n`;
    expect(parseDeployment(output)).toEqual([{ versionId: "v9", percentage: 100 }]);
  });

  it("reads a version's tag and message from its annotations", () => {
    const output = JSON.stringify({
      id: "v9",
      number: 12,
      annotations: { "workers/tag": "v1.4.0", "workers/message": "ace v1.4.0 (x)" },
      metadata: { source: "wrangler" },
    });
    expect(parseVersion(output)).toEqual({ id: "v9", tag: "v1.4.0", message: "ace v1.4.0 (x)" });
  });

  it("tells a Worker never deployed from a failure to ask", () => {
    expect(neverDeployed("✘ [ERROR] The Worker ace-cloud-staging has no deployments.")).toBe(true);
    expect(neverDeployed("This Worker does not exist on your account. [code: 10007]")).toBe(true);
    expect(neverDeployed("Authentication error [code: 10000]")).toBe(false);
  });
});
