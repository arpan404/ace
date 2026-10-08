import { expect, test } from "vitest";
import { loginObservation, loginUrl } from "./index.ts";

test("only verification and authorization links reach the client", () => {
  expect(loginUrl("codex", "https://auth.openai.com/codex/device")).toBe(
    "https://auth.openai.com/codex/device",
  );
  expect(
    loginUrl(
      "claude",
      "https://claude.ai/oauth/authorize?client_id=example&code_challenge=public-pkce&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback",
    ),
  ).toContain("code_challenge=public-pkce");
  for (const candidate of [
    "https://auth.openai.com/codex/device?access_token=sk-SYNTHETIC0123456789",
    "https://auth.openai.com/codex/device?state=ghp_SYNTHETIC0123456789",
    "https://auth.openai.com/codex/device#sk-SYNTHETIC0123456789",
    "https://auth.openai.com/codex/device/sk-SYNTHETIC0123456789",
    "https://auth.openai.com.evil.test/codex/device",
    "https://name:password@auth.openai.com/codex/device",
    "http://auth.openai.com/codex/device",
    "https://auth.openai.com/codex/device?redirect_uri=https%3A%2F%2Fevil.test%2Fcallback",
  ])
    expect(loginUrl("codex", candidate)).toBeUndefined();
});

test("device codes and fixed prompts can be relayed while arbitrary diagnostics remain private", () => {
  expect(loginObservation("codex", "Enter code: ABCD-12345")).toEqual({
    state: "awaiting_code_entry",
    userCode: "ABCD-12345",
  });
  expect(
    loginObservation("claude", "Press Enter to continue. Account-specific diagnostic data"),
  ).toEqual({ state: "awaiting_input", enter: true, prompt: "Press Enter to continue." });
  expect(loginObservation("claude", "Paste authorization code: private-value")).toMatchObject({
    manualRequired: true,
  });
  expect(loginObservation("opencode", "API key:")).toMatchObject({ manualRequired: true });
  expect(loginObservation("codex", "access_token=sk-SYNTHETIC0123456789")).toBeUndefined();
  expect(loginObservation("claude", "Error: the CLI said something private")).toBeUndefined();
});

test("Google authorization challenges belong only to ACP sign-in and never carry tokens", () => {
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&response_type=code&access_type=offline&prompt=consent";
  expect(loginUrl("antigravity", url)).toBe(url);
  expect(loginUrl("acp", url)).toBe(url);
  expect(loginUrl("opencode", url)).toBeUndefined();
  expect(loginUrl("acp", `${url}&access_token=private-value`)).toBeUndefined();
  expect(
    loginUrl("acp", url.replace("accounts.google.com", "accounts.google.com.evil.test")),
  ).toBeUndefined();
});
