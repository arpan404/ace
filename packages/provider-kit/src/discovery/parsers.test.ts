import { describe, expect, it } from "vitest";
import {
  parseClaudeAuth,
  parseCodexAuth,
  parseCursorAuth,
  parseOpenCodeAuth,
  parseVersion,
} from "./index.ts";
import { fixture } from "./testing/cli.ts";

describe("CLI auth parsing", () => {
  it("reports this machine's captured auth and versions without identity or credential fields", async () => {
    const expected = {
      claude: { version: "2.1.286", auth: { auth: "logged_in", authDetail: "claude.ai" } },
      codex: { version: "0.159.1", auth: { auth: "logged_in", authDetail: "ChatGPT" } },
      opencode: {
        version: "1.18.33",
        auth: {
          auth: "logged_in",
          authDetail: "GitHub Copilot, OpenCode Go, LMStudio",
          authEvidence: "credentials_configured",
        },
      },
      cursor: { version: "2026.09.26-dd393fe", auth: { auth: "logged_in" } },
    };
    const parsers = {
      claude: parseClaudeAuth,
      codex: parseCodexAuth,
      opencode: parseOpenCodeAuth,
      cursor: parseCursorAuth,
    };
    for (const provider of ["claude", "codex", "opencode", "cursor"] as const) {
      const captured = await fixture(provider);
      expect(parseVersion(provider, captured.version.stdout)).toBe(expected[provider].version);
      expect(parsers[provider](captured.auth.stdout || captured.auth.stderr)).toEqual(
        expected[provider].auth,
      );
    }
  });
  it("recognizes logged out outputs and treats unreadable status as unknown", () => {
    expect(parseClaudeAuth('{"loggedIn":false}')).toEqual({ auth: "logged_out" });
    expect(parseCodexAuth("Not logged in")).toEqual({ auth: "logged_out" });
    expect(parseCursorAuth("You are not logged in. Run agent login")).toEqual({
      auth: "logged_out",
    });
    expect(parseOpenCodeAuth("└  0 credentials")).toEqual({
      auth: "logged_out",
    });
    for (const parse of [parseClaudeAuth, parseCodexAuth, parseCursorAuth, parseOpenCodeAuth]) {
      expect(parse("Error: broken CLI")).toEqual({ auth: "unknown" });
      expect(parse("")).toEqual({ auth: "unknown" });
    }
  });
  it("recognizes Codex login methods without exposing the printed API key", () => {
    expect(parseCodexAuth("Logged in using ChatGPT")).toEqual({
      auth: "logged_in",
      authDetail: "ChatGPT",
    });
    expect(parseCodexAuth("Logged in using an API key - sk-synthetic-secret")).toEqual({
      auth: "logged_in",
      authDetail: "API key",
    });
    expect(parseVersion("codex", "codex-cli 0.159.1\n")).toBe("0.159.1");
  });
  it("ignores identity fields and unrecognized auth labels in JSON status", () => {
    expect(
      parseClaudeAuth(
        '{"loggedIn":true,"authMethod":"sk-synthetic-secret","email":"private@example.test","orgName":"private"}',
      ),
    ).toEqual({ auth: "logged_in" });
    expect(
      parseCursorAuth(
        '{"isAuthenticated":true,"userInfo":{"email":"private@example.test"},"accessToken":"synthetic-secret"}',
      ),
    ).toEqual({ auth: "logged_in" });
    expect(parseCursorAuth('{"isAuthenticated":false}')).toEqual({ auth: "logged_out" });
    expect(parseOpenCodeAuth("●  private@example.test api\n└  1 credential")).toEqual({
      auth: "logged_in",
      authDetail: "1 configured credentials",
      authEvidence: "credentials_configured",
    });
  });
  it("parses auth and versions when ANSI sequences interrupt meaningful words", () => {
    expect(parseCodexAuth("Logged \u001b[32min using ChatGPT\u001b[0m")).toEqual({
      auth: "logged_in",
      authDetail: "ChatGPT",
    });
    expect(parseOpenCodeAuth("●  GitHub \u001b[32mCopilot\u001b[0m api\n└  1 credential")).toEqual({
      auth: "logged_in",
      authDetail: "GitHub Copilot",
      authEvidence: "credentials_configured",
    });
    expect(parseVersion("codex", "\u001b[32mcodex-cli 0.159.1\u001b[0m")).toBe("0.159.1");
  });
});

it("OpenCode v2 version prefixes and connection counts remain non-secret evidence", () => {
  expect(parseVersion("opencode", "opencode v2.0.22\n")).toBe("2.0.22");
  expect(
    parseOpenCodeAuth(
      JSON.stringify([
        {
          id: "opencode-go",
          name: "private@example.test",
          connections: [
            { type: "credential", label: "secret label", key: "never-store" },
            { type: "env", name: "private environment", token: "never-store" },
          ],
        },
      ]),
    ),
  ).toEqual({
    auth: "unknown",
    authEvidence: "credentials_configured",
    authDetail: "2 configured connections; entitlement unverified",
  });
  expect(parseOpenCodeAuth("[]")).toEqual({ auth: "logged_out" });
  expect(
    parseOpenCodeAuth('[{"id":"future","connections":[{"type":"unknown","token":"never-store"}]}]'),
  ).toEqual({ auth: "unknown" });
});
