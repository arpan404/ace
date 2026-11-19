import { SettingsValues } from "@ace/protocol";
import { expect, test } from "vitest";
import { FakeDaemon } from "./daemon.ts";

/** A host whose home `/Users/dev` is a link to `/home/dev`, as the real daemon resolves it. */
function host() {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  daemon.projects.seedFolders(
    "/home/dev",
    [{ path: "/home/dev/work" }, { path: "/home/dev/ops" }],
    {
      homeLink: "/Users/dev",
    },
  );
  const roots = () =>
    SettingsValues.shape["projects.roots"].parse(daemon.services.settings.get("projects.roots"));
  return { daemon, roots };
}

test("a root added through the home link is removed by its real path with a trailing slash", () => {
  const { daemon, roots } = host();
  daemon.projects.command({ type: "workspace.root.add", path: "/Users/dev/work" });
  daemon.projects.command({ type: "workspace.root.add", path: "/home/dev/ops" });
  expect(roots()).toEqual(["/home/dev", "/home/dev/work", "/home/dev/ops"]);

  expect(
    daemon.projects.command({ type: "workspace.root.remove", path: "/home/dev/work/" }),
  ).toEqual({ ok: true });
  expect(roots()).toEqual(["/home/dev", "/home/dev/ops"]);
  daemon.projects.command({ type: "workspace.root.remove", path: "/Users/dev/ops" });
  expect(roots()).toEqual(["/home/dev"]);
});

test("the fake refuses to remove the last root, as the real daemon does", () => {
  const { daemon, roots } = host();
  daemon.projects.command({ type: "workspace.root.add", path: "/home/dev/work" });
  daemon.projects.command({ type: "workspace.root.remove", path: "/home/dev" });
  expect(
    daemon.projects.command({ type: "workspace.root.remove", path: "/home/dev/work" }),
  ).toEqual({ ok: false, error: "last_root" });
  expect(roots()).toEqual(["/home/dev/work"]);
});
