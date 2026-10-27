import { expect, test } from "vitest";
import {
  claudeToolListing,
  claudeToolListingAfter,
  type ClaudeToolSearchFacts,
} from "./claude-tool-search.ts";

const session = (
  env: Record<string, string> = {},
  more: Omit<ClaudeToolSearchFacts, "env"> = {},
): ClaudeToolSearchFacts => ({ env, ...more });

test.each([
  ["nothing configured", session()],
  ["ENABLE_TOOL_SEARCH=true", session({ ENABLE_TOOL_SEARCH: "true" })],
  ["ENABLE_TOOL_SEARCH=auto:0", session({ ENABLE_TOOL_SEARCH: "auto:0" })],
  ["an unrecognised ENABLE_TOOL_SEARCH", session({ ENABLE_TOOL_SEARCH: "maybe" })],
  [
    "the Anthropic API named as the base URL",
    session({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }),
  ],
  ["a current model", session({}, { model: "claude-opus-4-5-20251101" })],
  ["a model alias", session({}, { model: "haiku" })],
  [
    "Bedrock with a current model",
    session({ CLAUDE_CODE_USE_BEDROCK: "1" }, { model: "us.anthropic.claude-sonnet-4-5-v1:0" }),
  ],
  [
    "Vertex with a 4.5 model",
    session({ CLAUDE_CODE_USE_VERTEX: "1" }, { model: "claude-sonnet-4-5@20250929" }),
  ],
])("a Claude session lists every ace tool while tool search defers them: %s", (_, facts) => {
  expect(claudeToolListing(facts)).toBe("all");
});

test.each([
  ["ENABLE_TOOL_SEARCH=false", session({ ENABLE_TOOL_SEARCH: "false" })],
  ["ENABLE_TOOL_SEARCH=0", session({ ENABLE_TOOL_SEARCH: "0" })],
  ["ENABLE_TOOL_SEARCH=auto:100", session({ ENABLE_TOOL_SEARCH: "auto:100" })],
  ["experimental betas disabled", session({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" })],
  [
    "betas disabled even with ENABLE_TOOL_SEARCH=true",
    session({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "true", ENABLE_TOOL_SEARCH: "true" }),
  ],
  ["ToolSearch denied", session({}, { toolSearchDenied: true })],
  [
    "a Claude 3 model",
    session({ ENABLE_TOOL_SEARCH: "true" }, { model: "claude-3-5-haiku-20241022" }),
  ],
  [
    "a Claude 3 model from ANTHROPIC_MODEL",
    session({ ANTHROPIC_MODEL: "claude-3-7-sonnet-latest" }),
  ],
  [
    "a Claude 3 model on Bedrock",
    session(
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { model: "us.anthropic.claude-3-7-sonnet-20250219-v1:0" },
    ),
  ],
  [
    "a pre-4.5 model on Vertex",
    session({ CLAUDE_CODE_USE_VERTEX: "1" }, { model: "claude-opus-4-1@20250805" }),
  ],
  ["auto threshold mode", session({ ENABLE_TOOL_SEARCH: "auto" })],
  ["a custom auto threshold", session({ ENABLE_TOOL_SEARCH: "auto:5" })],
  ["a gateway base URL", session({ ANTHROPIC_BASE_URL: "https://llm.example.com/anthropic" })],
  ["the gateway switch", session({ CLAUDE_CODE_USE_GATEWAY: "1" })],
  ["Foundry", session({ CLAUDE_CODE_USE_FOUNDRY: "1" })],
])("a Claude session gets the core listing when tool search is off or may be: %s", (_, facts) => {
  expect(claudeToolListing(facts)).toBe("core");
});

test("a session's listing narrows when a model switch turns tool search off, and never widens", () => {
  const before = claudeToolListing(session({}, { model: "claude-opus-4-5" }));
  const narrowed = claudeToolListingAfter(before, session({}, { model: "claude-3-5-haiku" }));
  expect([before, narrowed]).toEqual(["all", "core"]);
  expect(claudeToolListingAfter(narrowed, session({}, { model: "claude-opus-4-5" }))).toBe("core");
});
