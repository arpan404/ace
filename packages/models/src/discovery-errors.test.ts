import { expect, test } from "vitest";
import { discoveryError, normalizeOpenCodeReport, ModelInstance } from "./index.ts";

test.each([
  [{ name: "AuthenticationError", message: "private token" }, "auth_expired"],
  [{ code: "not_configured" }, "not_configured"],
  [{ status: 403 }, "auth_expired"],
  [{ name: "NetworkError" }, "unreachable"],
  [{ code: "ECONNREFUSED" }, "unreachable"],
  [{ status: 503 }, "unreachable"],
  [
    { name: "ClientError", reason: "UnexpectedStatus", cause: { status: 401, body: "secret" } },
    "auth_expired",
  ],
  [
    { name: "ClientError", reason: "Transport", cause: new Error("private network address") },
    "unreachable",
  ],
  [new Error(JSON.stringify({ code: -32603, data: { code: "not_configured" } })), "not_configured"],
  [{ data: { message: "Unauthorized secret" } }, "auth_expired"],
])("safe provider error shapes produce an actionable category (%j)", (error, code) => {
  const detail = discoveryError(error, "discovery_failed", {
    provider: "cursor",
    backend: "cursor-sdk",
  });
  expect(detail.code).toBe(code);
  expect(JSON.stringify(detail)).not.toMatch(/private|secret|token/);
  if (code === "auth_expired" || code === "not_configured")
    expect(detail.hint).toContain("Sign in to Cursor");
  if (code === "not_configured")
    expect(detail).toMatchObject({
      hint: "Sign in to Cursor",
      severity: "info",
      actionId: "provider.sign_in",
    });
});

test.each([401, 403, 500, 502, 503])(
  "OpenCode source HTTP %s produces a sanitized picker hint",
  (status) => {
    const config = ModelInstance.parse({
      provider: "opencode",
      id: "account",
      executable: "fake",
      cwd: "/fake",
      loginRevision: "1",
    });
    const source = { id: "github-copilot", kind: "other" as const, label: "GitHub Copilot" };
    const result = normalizeOpenCodeReport(
      {
        location: { directory: config.cwd },
        data: [],
        errors: [{ providerID: source.id, error: { status, message: "private Bearer secret" } }],
      },
      config,
      new Map([[source.id, source]]),
    );
    expect(result.sources[0]?.error?.code).toBe(status < 500 ? "auth_expired" : "unreachable");
    expect(result.missingMetadata).toEqual([]);
    if (status < 500)
      expect(result.sources[0]?.error?.hint).toContain(
        "Reconnect GitHub Copilot in OpenCode (`opencode auth login`)",
      );
    expect(JSON.stringify(result)).not.toMatch(/private|secret/);
  },
);

test.each([
  { code: "discovery_failed", cause: { response: { status: 401 } } },
  { status: null, cause: { statusCode: "403" } },
  { _tag: "APIError", data: { statusCode: 401 } },
  { error: { code: "discovery_failed", response: { status: 401 } } },
])("nested auth failures survive generic wrappers and unrelated null fields (%j)", (error) => {
  expect(discoveryError(error).code).toBe("auth_expired");
});

test("unknown discovery failures expose only a fixed message and corrective hint", () => {
  const error = new Error(
    "Metadata bootstrap failed: Bearer private-bearer; configured key private-env-key",
  );
  const detail = discoveryError(error, "discovery_failed", {
    provider: "cursor",
    backend: "cursor-sdk",
  });
  expect(detail.code).toBe("discovery_failed");
  expect(detail.message).toBe("Model discovery failed.");
  expect(detail.hint).toContain("Check sign-in");
  expect(detail.message).not.toContain("private");
  expect(JSON.stringify(detail)).not.toContain("Metadata bootstrap failed");
});
