import { afterEach, describe, expect, it } from "vitest";

import { readByteLimitEnv } from "./resourceLimits";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("readByteLimitEnv", () => {
  it("reads the primary byte limit env var with units", () => {
    process.env.ACE_MEMORY_LIMIT = "5gb";
    process.env.ACE_SERVER_MEMORY_SOFT_LIMIT = "2gb";

    expect(
      readByteLimitEnv({
        envVarName: "ACE_MEMORY_LIMIT",
        fallbackEnvVarNames: ["ACE_SERVER_MEMORY_SOFT_LIMIT"],
        fallbackBytes: 4 * 1024 * 1024 * 1024,
      }),
    ).toBe(5 * 1024 * 1024 * 1024);
  });

  it("falls back to legacy env aliases when the primary env var is absent", () => {
    delete process.env.ACE_MEMORY_HARD_LIMIT;
    process.env.ACE_SERVER_MEMORY_HARD_LIMIT = "9g";

    expect(
      readByteLimitEnv({
        envVarName: "ACE_MEMORY_HARD_LIMIT",
        fallbackEnvVarNames: ["ACE_SERVER_MEMORY_HARD_LIMIT"],
        fallbackBytes: 8 * 1024 * 1024 * 1024,
      }),
    ).toBe(9 * 1024 * 1024 * 1024);
  });

  it("uses the default when no configured env var is valid", () => {
    process.env.ACE_MEMORY_LIMIT = "bad";
    process.env.ACE_SERVER_MEMORY_SOFT_LIMIT = "also-bad";

    expect(
      readByteLimitEnv({
        envVarName: "ACE_MEMORY_LIMIT",
        fallbackEnvVarNames: ["ACE_SERVER_MEMORY_SOFT_LIMIT"],
        fallbackBytes: 4 * 1024 * 1024 * 1024,
      }),
    ).toBe(4 * 1024 * 1024 * 1024);
  });
});
