import { describe, expect, it } from "vitest";
import { parseArguments } from "./args.ts";

describe("deploy arguments", () => {
  it("deploys ace cloud before the market when asked for both", () => {
    expect(parseArguments(["all", "production", "--version", "v1.2.0"])).toEqual({
      workers: ["cloud", "market"],
      environment: "production",
      version: "v1.2.0",
    });
  });

  it("deploys one Worker, untagged, to production", () => {
    expect(parseArguments(["market", "production"])).toEqual({
      workers: ["market"],
      environment: "production",
      version: undefined,
    });
  });

  it("takes --version=<tag>", () => {
    expect(parseArguments(["cloud", "production", "--version=v2.0.0"])).toMatchObject({
      version: "v2.0.0",
    });
  });

  it.each([
    [["cloud"], 'unknown environment ""'],
    [["relay", "production"], 'unknown Worker "relay"'],
    [["cloud", "prod"], 'unknown environment "prod"'],
    [["cloud", "staging"], 'unknown environment "staging"'],
    [["cloud", "production", "--version"], "--version needs a tag"],
    [["cloud", "production", "--force"], "unknown option --force"],
    [["cloud", "production", "extra"], "unexpected extra"],
  ])("refuses %j", (argv, message) => {
    expect(parseArguments(argv)).toBe(message);
  });
});
