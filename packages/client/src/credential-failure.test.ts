import { expect, test } from "vitest";
import { AceAccountError } from "./ace-account.ts";
import { credentialFailure } from "./credential-failure.ts";
import { ClientError } from "./types.ts";

test.each([
  ["signed out, or the device revoked", new ClientError("auth"), "final"],
  ["the machine code asked for", new ClientError("machine_code", "machine_code_required"), "final"],
  ["the account service refusing the sign-in", new AceAccountError(401), "final"],
  ["the account service refusing the device", new AceAccountError(403), "final"],
  ["the account backend erroring", new AceAccountError(502), "transient"],
  ["the account backend rate limiting", new AceAccountError(429), "transient"],
  ["the network gone", new TypeError("Failed to fetch"), "transient"],
  ["no network", new ClientError("offline"), "transient"],
  ["a fetch that timed out", new ClientError("timeout"), "transient"],
])("a credential that failed with %s is %s", (_name, error, outcome) => {
  expect(credentialFailure(error)).toBe(outcome);
});
