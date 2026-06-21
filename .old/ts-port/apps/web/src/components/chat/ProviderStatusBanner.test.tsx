import { type ServerProvider } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import { resolveProviderStatusDismissalKey } from "./providerStatusDismissal";

function createProviderStatus(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-05-12T22:10:00.000Z",
    message: "Codex is not authenticated. Run `codex login` and try again.",
    models: [],
    ...overrides,
  };
}

describe("ProviderStatusBanner", () => {
  it("uses a stable dismissal key for repeated provider errors", () => {
    const status = createProviderStatus();

    expect(resolveProviderStatusDismissalKey(status)).toBe(
      "codex:default:error:unauthenticated:Codex is not authenticated. Run `codex login` and try again.",
    );
    expect(resolveProviderStatusDismissalKey(createProviderStatus())).toBe(
      resolveProviderStatusDismissalKey(status),
    );
  });

  it("does not create dismissal keys for healthy or disabled providers", () => {
    expect(resolveProviderStatusDismissalKey(createProviderStatus({ status: "ready" }))).toBeNull();
    expect(
      resolveProviderStatusDismissalKey(createProviderStatus({ status: "disabled" })),
    ).toBeNull();
  });
});
