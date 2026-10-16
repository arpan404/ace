import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { ToolEnvVault } from "./tool-env-vault.ts";

const thread = ThreadId.parse("thread-1");
const other = ThreadId.parse("thread-2");

test("submitted credentials round-trip per thread", () => {
  const vault = new ToolEnvVault();
  expect(vault.submit(thread, { GH_TOKEN: "gho_one", GH_HOST: "ghe.example.com" })).toBe(2);
  expect(vault.get(thread)).toEqual({ GH_TOKEN: "gho_one", GH_HOST: "ghe.example.com" });
  expect(vault.get(other)).toBeUndefined();
});

test("denied entries never enter the vault", () => {
  const vault = new ToolEnvVault();
  expect(vault.submit(thread, { LD_PRELOAD: "/evil.so", NPM_TOKEN: "x" })).toBe(0);
  expect(vault.get(thread)).toBeUndefined();
  expect(vault.size).toBe(0);
});

test("reads are copies; empty submit releases the thread", () => {
  const vault = new ToolEnvVault();
  vault.submit(thread, { GH_TOKEN: "gho_one" });
  const read = vault.get(thread);
  expect(read).toEqual({ GH_TOKEN: "gho_one" });
  read!.GH_TOKEN = "mutated";
  expect(vault.get(thread)).toEqual({ GH_TOKEN: "gho_one" });
  expect(vault.submit(thread, {})).toBe(0);
  expect(vault.get(thread)).toBeUndefined();
});

test("dead threads read empty and are swept", () => {
  const vault = new ToolEnvVault();
  vault.submit(thread, { GH_TOKEN: "gho_one" });
  expect(vault.get(thread, () => false)).toBeUndefined();
  expect(vault.size).toBe(0);
});

test("capacity and thread identity are bounded", () => {
  const vault = new ToolEnvVault(1);
  vault.submit(thread, { GH_TOKEN: "gho_one" });
  expect(() => vault.submit(other, { GH_TOKEN: "gho_two" })).toThrow("full");
  vault.submit(thread, { GH_TOKEN: "gho_new" });
  expect(vault.get(thread)).toEqual({ GH_TOKEN: "gho_new" });
  expect(() => vault.submit("../evil" as never, { GH_TOKEN: "x" })).toThrow("Invalid thread");
  expect(() => new ToolEnvVault(0)).toThrow("Invalid tool credential capacity");
});
