import { ClientError } from "@ace/client";
import { AceAccountError } from "@ace/client/ace-account";
import { expect, test } from "vitest";
import { trackedGrant } from "./tracked-grant.ts";

const refusing = (error: unknown) => trackedGrant(() => Promise.reject(error));

test("a grant refused for want of an ace session reads as signed out", async () => {
  const grants = refusing(new ClientError("auth", "Sign in to your ace account again."));
  await expect(grants.grant()).rejects.toThrow();
  expect(grants.problem()).toBe("signed_out");
});

test("a grant the account backend refuses with 401 reads as an ended session", async () => {
  const grants = refusing(new AceAccountError(401));
  await expect(grants.grant()).rejects.toThrow();
  expect(grants.problem()).toBe("session_ended");
});

test("a grant lost to the network is neither, so the connection keeps retrying", async () => {
  const grants = refusing(new TypeError("Failed to fetch"));
  await expect(grants.grant()).rejects.toThrow();
  expect(grants.problem()).toBeUndefined();
});

test("a grant given after a refusal clears the reason", async () => {
  let signedIn = false;
  const grants = trackedGrant(async () => {
    if (!signedIn) throw new ClientError("auth");
    return "grant";
  });
  await expect(grants.grant()).rejects.toThrow();
  signedIn = true;
  expect(await grants.grant()).toBe("grant");
  expect(grants.problem()).toBeUndefined();
});
