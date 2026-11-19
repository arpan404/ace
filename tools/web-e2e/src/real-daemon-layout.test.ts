import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assertRemovable, e2eLayout, prepareFixtureRoot } from "./real-daemon-layout.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), "ace-e2e-layout-"));
  roots.push(root);
  return root;
}

test("both fixture folders sit in a folder of their own under the temporary root", () => {
  expect(e2eLayout("/tmp", "fixture-a")).toEqual({
    tmpRoot: "/tmp",
    root: join("/tmp", "ace-web-e2e"),
    name: "fixture-a",
    daemonHome: join("/tmp", "ace-web-e2e", "fixture-a"),
    projectsRoot: join("/tmp", "ace-web-e2e", "fixture-a-projects"),
  });
});

test.each(["", ".", "..", "../home", "a/b", "a\\b", "/abs", "x-projects", ".hidden"])(
  "a fixture name that isn't one plain folder name (%j) is refused",
  (name) => {
    expect(() => e2eLayout("/tmp", name)).toThrow("must be a plain folder name");
  },
);

test("only the daemon home and the projects root can be removed", () => {
  const layout = e2eLayout(tmpRoot(), "fixture");
  prepareFixtureRoot(layout);
  mkdirSync(layout.daemonHome);
  expect(() => assertRemovable(layout.daemonHome, layout)).not.toThrow();
  expect(() => assertRemovable(layout.projectsRoot, layout)).not.toThrow();
  for (const other of [layout.root, layout.tmpRoot, join(layout.daemonHome, ".."), "/"])
    expect(() => assertRemovable(other, layout)).toThrow("not an e2e fixture folder");
});

test("a fixture root that is a link, or a fixture folder that is one, is never removed through", () => {
  const outside = tmpRoot();
  const linked = e2eLayout(tmpRoot(), "fixture");
  symlinkSync(outside, linked.root);
  expect(() => assertRemovable(linked.daemonHome, linked)).toThrow("must be a folder, not a link");

  const layout = e2eLayout(tmpRoot(), "fixture");
  prepareFixtureRoot(layout);
  symlinkSync(outside, layout.projectsRoot);
  expect(() => assertRemovable(layout.projectsRoot, layout)).toThrow("it is a link");
});
