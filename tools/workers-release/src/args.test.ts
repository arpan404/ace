import { describe, expect, it } from "vitest";
import { parseArguments } from "./args.ts";

describe("deploy arguments", () => {
  it("deploys ace cloud before the market when asked for both", () => {
    expect(parseArguments(["all", "production", "--version", "v1.2.0"])).toEqual({
      workers: ["cloud", "market"],
      environment: "production",
      version: "v1.2.0",
      skipStagingCheck: false,
    });
  });

  it("deploys one Worker, untagged, to staging", () => {
    expect(parseArguments(["market", "staging"])).toEqual({
      workers: ["market"],
      environment: "staging",
      version: undefined,
      skipStagingCheck: false,
    });
  });

  it("takes --version=<tag> and the staging check override", () => {
    expect(
      parseArguments(["cloud", "production", "--version=v2.0.0", "--skip-staging-check"]),
    ).toMatchObject({ version: "v2.0.0", skipStagingCheck: true });
  });

  it.each([
    [["cloud"], 'unknown environment ""'],
    [["relay", "staging"], 'unknown Worker "relay"'],
    [["cloud", "prod"], 'unknown environment "prod"'],
    [["cloud", "staging", "--version"], "--version needs a tag"],
    [["cloud", "staging", "--force"], "unknown option --force"],
    [
      ["cloud", "staging", "--skip-staging-check"],
      "--skip-staging-check only applies to production",
    ],
    [["cloud", "staging", "extra"], "unexpected extra"],
  ])("refuses %j", (argv, message) => {
    expect(parseArguments(argv)).toBe(message);
  });
});
