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
  if (code === "not_configured") expect(detail.hint).toContain("Settings → Providers");
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
