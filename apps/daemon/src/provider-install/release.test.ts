import { expect, test } from "vitest";
import { installers } from "@ace/provider-kit/installers";
import { brewName, claudeChannel, parseRelease, platformPackage } from "./release.ts";

test("registry replies read as a release whatever shape the package manager prints", () => {
  expect(parseRelease('"1.5.0"\n')).toEqual({ version: "1.5.0", optionalDependencies: {} });
  expect(parseRelease("0.167.0")).toEqual({ version: "0.167.0", optionalDependencies: {} });
  expect(
    parseRelease(
      JSON.stringify({ version: "2.1.321", optionalDependencies: { "x-darwin-arm64": "2.1.321" } }),
    ),
  ).toEqual({ version: "2.1.321", optionalDependencies: { "x-darwin-arm64": "2.1.321" } });
  for (const unusable of [undefined, "", "not a version", '{"name":"x"}', "1.2"])
    expect(parseRelease(unusable)).toBeUndefined();
});

const release = (optionalDependencies: Record<string, string>) => ({
  version: "2.0.0",
  optionalDependencies,
});

test.each([
  {
    name: "Claude's per-platform package",
    pkg: "@anthropic-ai/claude-code",
    deps: {
      "@anthropic-ai/claude-code-darwin-x64": "2.0.0",
      "@anthropic-ai/claude-code-darwin-arm64": "2.0.0",
    },
    host: ["darwin", "arm64"],
    expected: "@anthropic-ai/claude-code-darwin-arm64@2.0.0",
  },
  {
    name: "Codex's alias to a platform version of itself",
    pkg: "@openai/codex",
    deps: {
      "@openai/codex-linux-arm64": "npm:@openai/codex@2.0.0-linux-arm64",
      "@openai/codex-linux-x64": "npm:@openai/codex@2.0.0-linux-x64",
    },
    host: ["linux", "x64"],
    expected: "@openai/codex@2.0.0-linux-x64",
  },
  {
    name: "OpenCode's plain build, not its baseline variant",
    pkg: "@opencode/cli",
    deps: {
      "@opencode/cli-darwin-x64-baseline": "2.0.0",
      "@opencode/cli-darwin-x64": "2.0.0",
    },
    host: ["darwin", "x64"],
    expected: "@opencode/cli-darwin-x64@2.0.0",
  },
  {
    name: "an aarch64-named package on arm64",
    pkg: "tool",
    deps: { "tool-linux-aarch64": "2.0.0" },
    host: ["linux", "arm64"],
    expected: "tool-linux-aarch64@2.0.0",
  },
  {
    name: "nothing for a third-party native dependency",
    pkg: "@google/gemini-cli",
    deps: { "@lydell/node-pty-darwin-arm64": "1.1.0" },
    host: ["darwin", "arm64"],
    expected: undefined,
  },
  {
    name: "nothing for a range rather than a published version",
    pkg: "tool",
    deps: { "tool-darwin-arm64": "^2.0.0" },
    host: ["darwin", "arm64"],
    expected: undefined,
  },
])("the binary package for this computer: $name", ({ pkg, deps, host, expected }) => {
  expect(platformPackage(pkg, release(deps), host[0] ?? "", host[1] ?? "")).toBe(expected);
});

test("a Homebrew binary updates under the name it was installed with", () => {
  const claude = installers.claude;
  expect(brewName(claude, "/opt/homebrew/Caskroom/claude-code@latest/2.1.321/claude")).toBe(
    "claude-code@latest",
  );
  expect(brewName(claude, "/opt/homebrew/Caskroom/claude-code/2.1.311/claude")).toBe("claude-code");
  expect(brewName(claude, "/somewhere/else/claude")).toBe("claude-code");
  expect(brewName(installers.pi, "/opt/homebrew/Cellar/pi/1.0.0/pi")).toBeUndefined();
});

test("Claude's release channel is read from its settings and ignored when unset or invalid", () => {
  expect(claudeChannel('{"autoUpdatesChannel":"stable"}')).toBe("stable");
  expect(claudeChannel('{"autoUpdatesChannel":"latest","model":"x"}')).toBe("latest");
  for (const unset of [undefined, "", "{", "{}", '{"autoUpdatesChannel":"nightly"}'])
    expect(claudeChannel(unset)).toBeUndefined();
});
