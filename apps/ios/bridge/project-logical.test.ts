import { Project } from "@ace/protocol";
import { expect, test } from "vitest";
import { logicalIds } from "./project-logical.ts";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const ace = { remotes: ["github.com/arpan/ace"], subpath: "" };

const project = (id: string, extra: Record<string, unknown> = {}) =>
  Project.parse({ id, name: id, path: `/code/${id}`, ...extra });

/** Whether Swift's `sameProject` would take `there` for `here`: their ids meet. */
const meet = (a: string[] | undefined, b: string[] | undefined) =>
  !!a?.length && !!b?.some((id) => a.includes(id));

test("clones grouped only by their remotes are found on the other machine", () => {
  // Each daemon minted its own identity; only the remotes say they are one repository.
  const mac = logicalIds([
    project("ace-mac", { identity: { id: P, aliases: [], source: "created" }, remoteKey: ace }),
  ]);
  const omarchy = logicalIds([
    project("ace-omarchy", {
      identity: { id: Q, aliases: [], source: "created" },
      remoteKey: { ...ace },
    }),
  ]);
  expect(meet(mac.get("ace-mac"), omarchy.get("ace-omarchy"))).toBe(true);
});

test("a checkout grouped here through a clone's remotes carries them, so it is found there too", () => {
  // Here: a worktree with only an identity, linked to a clone with a remote key.
  const mac = logicalIds([
    project("worktree", { identity: { id: P, aliases: [], source: "created" } }),
    project("clone", { identity: { id: P, aliases: [], source: "created" }, remoteKey: ace }),
  ]);
  const omarchy = logicalIds([
    project("there", { identity: { id: R, aliases: [], source: "created" }, remoteKey: ace }),
  ]);
  expect(meet(mac.get("worktree"), omarchy.get("there"))).toBe(true);
});

test("a fork, another folder of the repository and an unrelated project are not found", () => {
  const mac = logicalIds([
    project("ace", { identity: { id: P, aliases: [], source: "created" }, remoteKey: ace }),
  ]);
  const omarchy = logicalIds([
    project("fork", {
      identity: { id: Q, aliases: [], source: "created" },
      remoteKey: { remotes: ["github.com/arpan/ace", "github.com/someone/ace"], subpath: "" },
    }),
    project("web", {
      identity: { id: R, aliases: [], source: "created" },
      remoteKey: { ...ace, subpath: "apps/web" },
    }),
    project("notes"),
  ]);
  for (const there of ["fork", "web", "notes"])
    expect(meet(mac.get("ace"), omarchy.get(there)), there).toBe(false);
});
