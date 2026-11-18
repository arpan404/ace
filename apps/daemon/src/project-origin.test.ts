import { expect, test } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import {
  identitySuggestions,
  sameOriginProject,
  type Checkout,
  type OriginReader,
} from "./project-origin.ts";

interface Folder {
  origin?: string;
  remotes?: string[];
  subpath?: string;
}

/** Checkouts by path, read the way Git would answer, counting each read. */
function reader(folders: Record<string, Folder>) {
  const reads: string[] = [];
  const git: OriginReader = {
    async transferOrigin(path) {
      reads.push(path);
      const origin = folders[path]?.origin;
      return origin ? { url: origin, normalized: origin } : undefined;
    },
    async checkoutFacts(path): Promise<Checkout | undefined> {
      const folder = folders[path];
      if (!folder) return undefined;
      return {
        remotes: folder.remotes ?? (folder.origin ? [folder.origin] : []),
        subpath: folder.subpath ?? "",
      };
    },
  };
  return { git, reads };
}

const list = (paths: readonly string[]) =>
  paths.map((path) => ({ workspaceId: `id-${path}` as WorkspaceId, path }));

test("a same-origin checkout past the 64th registration is still found", async () => {
  const paths = Array.from({ length: 120 }, (_, index) => `p${index}`);
  const folders = Object.fromEntries(
    paths.map((path, index) => [
      path,
      { origin: index === 100 ? "github.com/acme/shared" : `github.com/acme/${path}` },
    ]),
  );
  const { git } = reader(folders);
  expect(await sameOriginProject(git, list(paths), "github.com/acme/shared")).toBe("id-p100");
});

test("of two checkouts of one repository, the one at the same subpath wins over a newer one", async () => {
  const { git } = reader({
    newer: { origin: "github.com/acme/mono", subpath: "web" },
    older: { origin: "github.com/acme/mono", subpath: "api" },
  });
  // Most recently used first.
  const projects = list(["newer", "older"]);
  expect(await sameOriginProject(git, projects, "github.com/acme/mono", "api")).toBe("id-older");
  expect(await sameOriginProject(git, projects, "github.com/acme/mono", "web")).toBe("id-newer");
});

test("with no checkout at the subpath, the most recently used match is the one found", async () => {
  const { git } = reader({
    unrelated: { origin: "github.com/acme/other" },
    recent: { origin: "github.com/acme/app", subpath: "tools" },
    old: { origin: "github.com/acme/app", subpath: "docs" },
  });
  expect(
    await sameOriginProject(git, list(["unrelated", "recent", "old"]), "github.com/acme/app"),
  ).toBe("id-recent");
});

test("a checkout at the subpath stops the reading of older ones", async () => {
  const paths = Array.from({ length: 40 }, (_, index) => `p${index}`);
  const { git, reads } = reader(
    Object.fromEntries(paths.map((path) => [path, { origin: "github.com/acme/app" }])),
  );
  expect(await sameOriginProject(git, list(paths), "github.com/acme/app")).toBe("id-p0");
  // Reads run eight at a time; nothing past the first batch's reach is read.
  expect(reads.length).toBeLessThanOrEqual(16);
});

test("a checkout whose origin can't be read is skipped, not fatal", async () => {
  const { git } = reader({ ok: { origin: "github.com/acme/app" } });
  const failing: OriginReader = {
    transferOrigin: (path) =>
      path === "broken" ? Promise.reject(new Error("git_failed")) : git.transferOrigin(path),
    checkoutFacts: (path) => git.checkoutFacts(path),
  };
  expect(await sameOriginProject(failing, list(["broken", "ok"]), "github.com/acme/app")).toBe(
    "id-ok",
  );
});

test("suggestions share any remote, not just origin, at the same subpath", async () => {
  const { git } = reader({
    // A fork: origin is the fork, upstream is the shared repository.
    fork: { remotes: ["github.com/me/app", "github.com/acme/app"] },
    same: { remotes: ["github.com/acme/app"] },
    other: { remotes: ["github.com/acme/other"] },
    plain: {},
  });
  expect(
    await identitySuggestions(
      git,
      list(["fork", "same", "other", "plain", "missing"]),
      ["github.com/acme/app"],
      "",
    ),
  ).toEqual([
    { workspaceId: "id-fork", shared: ["github.com/acme/app"], sameRemotes: false },
    { workspaceId: "id-same", shared: ["github.com/acme/app"], sameRemotes: true },
  ]);
});

test("monorepo folders sharing a remote are never suggested for each other", async () => {
  const { git } = reader({
    api: { origin: "github.com/acme/mono", subpath: "api" },
    web: { origin: "github.com/acme/mono", subpath: "web" },
  });
  const projects = list(["api", "web"]);
  expect(await identitySuggestions(git, projects, ["github.com/acme/mono"], "api")).toEqual([
    { workspaceId: "id-api", shared: ["github.com/acme/mono"], sameRemotes: true },
  ]);
  expect(await identitySuggestions(git, projects, ["github.com/acme/mono"], "")).toEqual([]);
});

test("no remotes asked for suggests nothing and reads nothing", async () => {
  const { git, reads } = reader({ a: { origin: "github.com/acme/a" } });
  expect(await identitySuggestions(git, list(["a"]), [], "")).toEqual([]);
  expect(reads).toEqual([]);
});
