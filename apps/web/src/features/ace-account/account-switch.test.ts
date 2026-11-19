import { expect, test } from "vitest";
import { fakeAccountBackend, fakePerson } from "@/boot/fake-account.ts";
import { memoryKeyValue } from "@/test/harness.tsx";
import { followAccountLeaving } from "./account-switch.ts";
import { aceAccountStore } from "./session-store.ts";

const other = { id: "user_other", email: "work@example.com", name: "Work" };
const session = (account: typeof other) => ({
  token: "o".repeat(43),
  expiresAt: Date.now() + 86_400_000,
  account,
});

/** A window signed in to the fake person's account, and the accounts it reported leaving. */
async function window() {
  const store = aceAccountStore(fakeAccountBackend(memoryKeyValue(), Date.now));
  await store.restore(new AbortController().signal);
  const left: string[] = [];
  followAccountLeaving(store, (id) => left.push(id));
  return { store, left };
}

test("signing out reports the account the window left; signing back in to it reports nothing", async () => {
  const { store, left } = await window();
  await store.signOut();
  expect(left).toEqual([fakePerson.id]);
  await store.signedIn(session(fakePerson));
  expect(left).toEqual([fakePerson.id]);
});

test("another account signing in reports the one it replaced", async () => {
  const { store, left } = await window();
  await store.signedIn(session(other));
  expect(left).toEqual([fakePerson.id]);
});

test("a session the backend ended reports its account", async () => {
  const { store, left } = await window();
  await store.ended();
  expect(left).toEqual([fakePerson.id]);
});

test("the same account's session being saved again reports nothing", async () => {
  const { store, left } = await window();
  await store.signedIn(session(fakePerson));
  expect(left).toEqual([]);
});
