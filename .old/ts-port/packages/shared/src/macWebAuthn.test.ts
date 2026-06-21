import { describe, expect, it } from "vitest";

import {
  APPLE_TEAM_ID_ENV,
  MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP_ENV,
  MAC_WEBAUTHN_TEAM_ID_ENV,
  createMacWebAuthnKeychainAccessGroup,
  normalizeMacTeamId,
  normalizeMacWebAuthnKeychainAccessGroup,
  parseMacWebAuthnRuntimeConfig,
  resolveMacWebAuthnKeychainAccessGroup,
} from "./macWebAuthn";

describe("macWebAuthn", () => {
  it("normalizes Apple team ids", () => {
    expect(normalizeMacTeamId(" abc123def4 ")).toBe("ABC123DEF4");
    expect(normalizeMacTeamId("too-short")).toBeNull();
    expect(normalizeMacTeamId("abc123def45")).toBeNull();
  });

  it("normalizes keychain access groups", () => {
    expect(normalizeMacWebAuthnKeychainAccessGroup(" ABC123DEF4.com.ace.ace.webauthn ")).toBe(
      "ABC123DEF4.com.ace.ace.webauthn",
    );
    expect(normalizeMacWebAuthnKeychainAccessGroup("com.ace.ace.webauthn")).toBeNull();
    expect(normalizeMacWebAuthnKeychainAccessGroup("ABC123DEF4")).toBeNull();
  });

  it("creates the default ace WebAuthn keychain access group from a team id", () => {
    expect(
      createMacWebAuthnKeychainAccessGroup({
        appBundleId: "com.ace.ace",
        teamId: "abc123def4",
      }),
    ).toBe("ABC123DEF4.com.ace.ace.webauthn");
  });

  it("prefers an explicit keychain group over team-id derived groups", () => {
    expect(
      resolveMacWebAuthnKeychainAccessGroup({
        appBundleId: "com.ace.ace",
        env: {
          [MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP_ENV]: "ZZZ123DEF4.com.example.custom",
          [MAC_WEBAUTHN_TEAM_ID_ENV]: "ABC123DEF4",
        },
      }),
    ).toBe("ZZZ123DEF4.com.example.custom");
  });

  it("falls back from runtime config to environment team ids", () => {
    expect(
      resolveMacWebAuthnKeychainAccessGroup({
        appBundleId: "com.ace.ace",
        env: { [APPLE_TEAM_ID_ENV]: "abc123def4" },
        runtimeConfig: {},
      }),
    ).toBe("ABC123DEF4.com.ace.ace.webauthn");
  });

  it("parses runtime config defensively", () => {
    expect(
      parseMacWebAuthnRuntimeConfig(
        JSON.stringify({
          macWebAuthnKeychainAccessGroup: "ABC123DEF4.com.ace.ace.webauthn",
        }),
      ),
    ).toEqual({ macWebAuthnKeychainAccessGroup: "ABC123DEF4.com.ace.ace.webauthn" });
    expect(parseMacWebAuthnRuntimeConfig("{")).toBeNull();
    expect(
      parseMacWebAuthnRuntimeConfig(JSON.stringify({ macWebAuthnKeychainAccessGroup: "" })),
    ).toEqual({});
  });
});
