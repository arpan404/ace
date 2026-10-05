import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readLocalToken } from "./local-token.ts";

const homes: string[] = [];
afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function tempHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "ace-token-"));
  homes.push(directory);
  return directory;
}

test("prints the token from the daemon's own home, without the trailing newline", () => {
  const directory = tempHome();
  const token = "ab".repeat(32);
  writeFileSync(join(directory, "daemon-token"), `${token}\n`);
  expect(readLocalToken(directory)).toBe(token);
});

test("before the daemon has ever started, says to start it instead of failing with ENOENT", () => {
  const directory = tempHome();
  expect(() => readLocalToken(directory)).toThrow(/Start the daemon with `ace start`/);
});

test("a damaged token file is reported, never printed", () => {
  const directory = tempHome();
  writeFileSync(join(directory, "daemon-token"), "not-a-token");
  expect(() => readLocalToken(directory)).toThrow(/not valid/);
});
