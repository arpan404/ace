import { expect, test } from "vitest";
import {
  PluginNameInput,
  PluginRef,
  PluginRepository,
  sourceText,
  suggestedPluginName,
} from "./plugin-source.ts";

test("a GitHub owner/name becomes its git URL; URLs and local paths pass through", () => {
  expect(PluginRepository.parse(" getsentry/sentry-mcp ")).toBe(
    "https://github.com/getsentry/sentry-mcp.git",
  );
  expect(PluginRepository.parse("git@github.com:acme/tools.git")).toBe(
    "git@github.com:acme/tools.git",
  );
  expect(PluginRepository.parse("/Users/me/plugins")).toBe("/Users/me/plugins");
  expect(PluginRepository.safeParse("not a repo").success).toBe(false);
});

test("the plugin name is suggested from the repository and must be a marketplace name", () => {
  expect(suggestedPluginName("https://github.com/getsentry/Sentry_MCP.git")).toBe("sentry-mcp");
  expect(PluginNameInput.parse("Sentry")).toBe("sentry");
  expect(PluginNameInput.safeParse("two--dashes").success).toBe(false);
});

test("a ref is a branch, tag or commit git can fetch", () => {
  expect(PluginRef.parse(" release/2.1 ")).toBe("release/2.1");
  expect(PluginRef.safeParse("main..dev").success).toBe(false);
  expect(PluginRef.safeParse("-x").success).toBe(false);
});

test("a source reads as people type it, naming the ref unless it is the default branch", () => {
  expect(sourceText("https://github.com/getsentry/sentry-mcp.git", "main")).toBe(
    "getsentry/sentry-mcp @ main",
  );
  expect(sourceText("https://github.com/getsentry/sentry-mcp.git", "HEAD")).toBe(
    "getsentry/sentry-mcp",
  );
  expect(sourceText("/Users/me/plugins", undefined)).toBe("/Users/me/plugins");
});
