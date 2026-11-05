import { ClientError } from "@ace/client";
import { AceAccountError } from "@ace/client/ace-account";
import { expect, test } from "vitest";
import { accountPinnedGrant, trackedGrant } from "./tracked-grant.ts";

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

/** Grants for a machine chosen on `chosenOn`, while the window holds `holding.id`. */
function pinned(chosenOn: string | undefined, holding: { id: string | undefined }) {
  return trackedGrant(
    accountPinnedGrant(
      chosenOn,
      async () => holding.id,
      async () => {
        if (holding.id === undefined) throw new ClientError("auth");
        return `grant for ${holding.id}`;
      },
    ),
  );
}

test("a machine chosen on another account than the window's reads as on the other account", async () => {
  const grants = pinned("user_home", { id: "user_work" });
  await expect(grants.grant()).rejects.toThrow();
  expect(grants.problem()).toBe("other_account");
});

test("a machine whose choice kept no account is pinned to the account of its first grant", async () => {
  const holding = { id: "user_home" as string | undefined };
  const grants = pinned(undefined, holding);
  expect(await grants.grant()).toBe("grant for user_home");
  holding.id = undefined;
  await expect(grants.grant()).rejects.toThrow();
  expect(grants.problem()).toBe("signed_out");
  holding.id = "user_work";
  await expect(grants.grant()).rejects.toThrow();
  expect(grants.problem()).toBe("other_account");
  // Signing back in to the machine's account opens it again.
  holding.id = "user_home";
  expect(await grants.grant()).toBe("grant for user_home");
  expect(grants.problem()).toBeUndefined();
});
