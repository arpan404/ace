import { expect, test } from "vitest";
import { launchPaths } from "./spawn-path.ts";

function shell() {
  const { promise: login, resolve: answer } = Promise.withResolvers<string>();
  return { login, answer };
}

test("spawns at once with a saved PATH, before the login shell answers", async () => {
  const { login } = shell();
  const saved: string[] = [];
  const spawn = await launchPaths({
    saved: "/opt/homebrew/bin:/usr/bin",
    login,
    save: (path) => saved.push(path),
  }).next();
  expect(spawn.path).toBe("/opt/homebrew/bin:/usr/bin");
  expect(spawn.confirm).toBeDefined();
  expect(saved).toEqual([]);
});

test("waits for the login shell on a first launch, with nothing saved", async () => {
  const { login, answer } = shell();
  const saved: string[] = [];
  let spawned: { path: string; confirm?: Promise<string> } | undefined;
  const next = launchPaths({ saved: undefined, login, save: (path) => saved.push(path) })
    .next()
    .then((spawn) => (spawned = spawn));
  await Promise.resolve();
  expect(spawned).toBeUndefined();
  answer("/opt/homebrew/bin:/usr/bin");
  await next;
  // The daemon gets the shell's PATH itself: nothing follows on its stdin.
  expect(spawned).toEqual({ path: "/opt/homebrew/bin:/usr/bin" });
  expect(saved).toEqual(["/opt/homebrew/bin:/usr/bin"]);
});

test("a changed login PATH is saved and reaches the daemon spawned on the old one", async () => {
  const { login, answer } = shell();
  const saved: string[] = [];
  const paths = launchPaths({ saved: "/usr/bin", login, save: (path) => saved.push(path) });
  const spawn = await paths.next();
  answer("/Users/me/.local/bin:/usr/bin");
  expect(await spawn.confirm).toBe("/Users/me/.local/bin:/usr/bin");
  expect(saved).toEqual(["/Users/me/.local/bin:/usr/bin"]);
  // A restart after the shell answered spawns on its PATH, with nothing to hand over.
  expect(await paths.next()).toEqual({ path: "/Users/me/.local/bin:/usr/bin" });
});

test("an unchanged login PATH saves nothing", async () => {
  const { login, answer } = shell();
  const saved: string[] = [];
  const spawn = await launchPaths({
    saved: "/opt/homebrew/bin:/usr/bin",
    login,
    save: (path) => saved.push(path),
  }).next();
  answer("/opt/homebrew/bin:/usr/bin");
  expect(await spawn.confirm).toBe("/opt/homebrew/bin:/usr/bin");
  expect(saved).toEqual([]);
});
