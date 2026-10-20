import { expect, test } from "vitest";
import { parseClaudeAuth } from "@ace/provider-kit/discovery";
import { reportedAuthMethod } from "./provider-account-support.ts";

const claudeMethod = (authMethod: string) =>
  reportedAuthMethod(parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod })).authDetail);

test("Claude signed in with a key, a key helper or a setup token reports how, not unknown", () => {
  expect(claudeMethod("apiKey")).toBe("api_key");
  expect(claudeMethod("api_key_helper")).toBe("api_key");
  expect(claudeMethod("oauth_token")).toBe("browser");
  expect(claudeMethod("claude.ai")).toBe("browser");
  expect(claudeMethod("bedrock")).toBe("unknown");
});
