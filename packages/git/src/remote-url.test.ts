import { expect, test } from "vitest";
import { normalizeRemoteUrl } from "./remote-url.ts";

const same = (a: string, b: string) => normalizeRemoteUrl(a) === normalizeRemoteUrl(b);

test.each([
  // A public forge serves repositories by name: every spelling is one repository.
  ["git@github.com:o/r.git", "ssh://git@github.com/o/r"],
  ["git@github.com:o/r", "https://github.com/o/r"],
  ["ssh://git@gitlab.com/group/app.git", "https://gitlab.com/group/app"],
  ["git@bitbucket.org:team/app.git", "ssh://git@bitbucket.org/team/app"],
  ["git@codeberg.org:o/r", "https://codeberg.org/o/r.git"],
  // Elsewhere over SSH: a path from the root, however it's spelled, is the same path.
  ["git@forge:/srv/team/app.git", "ssh://git@forge/srv/team/app"],
  ["ssh://git@forge:22/team/app", "ssh://forge/team/app.git"],
  ["ssh://git@forge/team/app", "https://forge/team/app"],
  // The login user's home, however it's spelled.
  ["git@forge:team/app.git", "git@forge:~/team/app"],
  ["git@forge:team/app", "ssh://git@forge/~/team/app"],
  ["git@forge:team/app", "ssh://git@forge:22/~git/team/app.git"],
  ["git@forge:~bob/app", "ssh://alice@forge/~bob/app"],
  // Port rules are unchanged.
  ["https://forge:443/team/app", "http://forge:80/team/app"],
  // A path from the root whose first folder starts with `~`, however it's spelled.
  ["git@box:/~git/team/app.git", "ssh://git@box//~git/team/app"],
  ["git@box:/~git/team/app", "https://box/~git/team/app"],
])("%s and %s are one repository", (a, b) => {
  expect(same(a, b)).toBe(true);
});

test.each([
  // Home-relative against from the root: `~git/team/app` is not `/team/app`.
  ["git@forge:team/app.git", "ssh://git@forge/team/app.git"],
  ["git@forge:team/app", "git@forge:/team/app"],
  ["ssh://git@forge/~/team/app", "ssh://git@forge/team/app"],
  ["git@forge:team/app", "https://forge/team/app"],
  // A home against a folder from the root that happens to be named like one.
  ["git@box:team/app.git", "git@box:/~git/team/app.git"],
  ["ssh://git@box/~git/team/app", "ssh://git@box//~git/team/app"],
  ["git@box:~bob/app", "https://box/~bob/app"],
  // Two users' homes.
  ["alice@forge:app", "bob@forge:app"],
  ["ssh://forge/~alice/app", "ssh://forge/~bob/app"],
  // Ports.
  ["ssh://git@forge:2222/team/app.git", "ssh://git@forge:2223/team/app.git"],
  ["ssh://git@forge:2222/team/app.git", "ssh://git@forge/team/app.git"],
  ["ssh://git@[::1]:2222/team/app", "ssh://git@[::1]/team/app"],
  ["forge:2222/team/app.git", "ssh://git@forge:2222/team/app.git"],
  ["https://forge:8443/team/app.git", "https://forge/team/app.git"],
  // Owners, path case and hosts.
  ["git@github.com:o/r", "git@github.com:O/R"],
  ["git@github.com:o/r", "git@gitlab.com:o/r"],
])("%s and %s are different repositories", (a, b) => {
  expect(same(a, b)).toBe(false);
});

test("a key outside a public forge names its version, so an older daemon's key never equals it", () => {
  // An older daemon keyed both of these `forge/team/app`, from the root or not.
  expect(normalizeRemoteUrl("ssh://git@forge/team/app.git")).toBe("v2:forge/team/app");
  expect(normalizeRemoteUrl("git@forge:team/app.git")).toBe("v2:forge/~git/team/app");
  expect(normalizeRemoteUrl("git@forge:/~git/team/app.git")).toBe("v2:forge//~git/team/app");
  // A public forge's key means what it always did, so it stays as it was.
  expect(normalizeRemoteUrl("git@github.com:o/r.git")).toBe("github.com/o/r");
  // As does a path on this machine's own disk.
  expect(normalizeRemoteUrl("/srv/git/app.git")).toBe("/srv/git/app.git");
});
