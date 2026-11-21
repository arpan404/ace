import { expect, test } from "vitest";
import type { MachineAccountStatus } from "@ace/protocol";
import type { AceAccount } from "@ace/protocol/ace-account";
import { machineAccountRow } from "./machine-account-copy.ts";
import { machineOwnerRow } from "./machine-owner-copy.ts";

const me: AceAccount = { id: "user_p", email: "p@example.com", name: "Pat", emailVerified: true };
const them: AceAccount = {
  id: "user_q",
  email: "q@example.com",
  name: "Quinn",
  emailVerified: true,
};
const status = (extra: Partial<MachineAccountStatus>): MachineAccountStatus => ({
  signedIn: true,
  machineCode: { set: false },
  ...extra,
});

test("the owner sees the machine is theirs and can let it go", () => {
  expect(machineOwnerRow(status({ account: them, owner: { account: me.id } }), me)).toEqual({
    sentence: "This machine belongs to you (p@example.com).",
    action: "release",
  });
});

test("someone else's ownership is named and offers the way to take it back, even when the machine is signed in to you", () => {
  expect(machineOwnerRow(status({ account: them, owner: { account: them.id } }), me)).toEqual({
    sentence: "This machine belongs to q@example.com.",
    action: "notYou",
  });
  expect(machineOwnerRow(status({ account: me, owner: { account: them.id } }), me)).toEqual({
    sentence: "This machine belongs to another ace account.",
    action: "notYou",
  });
});

test("a machine nobody owns yet says so, and an older daemon's says nothing", () => {
  expect(machineOwnerRow(status({ owner: null }), me)?.action).toBe("none");
  expect(machineOwnerRow(status({}), me)).toBeUndefined();
});

test("an organization's host says so, and offers nobody's personal release", () => {
  expect(machineOwnerRow(status({ account: me, owner: { org: "org_team" } }), me)).toEqual({
    sentence: "This machine is an organization's host: its owners can release it.",
    action: "none",
  });
});

test("an org host signed in as its organization is named by the organization, never its placeholder address", () => {
  const acme: AceAccount = { id: "org:org_01ACME", email: "host@org_01acme.invalid", name: "Acme" };
  const host = status({ account: acme, owner: { org: "org_01ACME" } });
  expect(machineOwnerRow(host, me)?.sentence).toBe(
    "This machine is Acme's host: its owners can release it.",
  );
  const row = machineAccountRow(host, me);
  expect(row.sentence).toContain("Signed in as Acme");
  expect(row.sentence).not.toContain(".invalid");
  // Nothing to sign out or switch: the host's own sign-in isn't a person's.
  expect(row.action).toBe("none");
});
