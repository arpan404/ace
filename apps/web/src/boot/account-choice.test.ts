import { expect, test } from "vitest";
import {
  forgetToken,
  loadAccountChoice,
  loadTarget,
  saveAccountChoice,
  saveTarget,
} from "./connection-settings.ts";
import { memoryKeyValue } from "@/test/harness.tsx";

const machine = { origin: "https://account.example.com", hostId: "S".repeat(52), name: "Studio" };
const target = { url: "ws://127.0.0.1:4242/", token: "a".repeat(64) };

test("choosing an account machine forgets the stored token, so only it opens after a reload", () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  saveTarget(stores, target, true);
  saveAccountChoice(stores, machine);
  expect(loadAccountChoice(stores)).toEqual(machine);
  expect(loadTarget(stores).target).toBeUndefined();
});

test("connecting by address afterwards forgets the account machine", () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  saveAccountChoice(stores, machine);
  saveTarget(stores, target, false);
  expect(loadAccountChoice(stores)).toBeUndefined();
  expect(loadTarget(stores).target).toEqual(target);
});

test("disconnecting forgets the account machine too", () => {
  const stores = { local: memoryKeyValue(), session: memoryKeyValue() };
  saveAccountChoice(stores, machine);
  forgetToken(stores);
  expect(loadAccountChoice(stores)).toBeUndefined();
});
