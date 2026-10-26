import { expect, test } from "vitest";
import { FakeDaemon } from "./index.ts";

/** The fake's other machine reuses its project for a repository as the daemon compares origins. */
function arrives(daemon: FakeDaemon, origin: string) {
  return daemon.projects.receive({ name: "weather", origin });
}

test("a transfer reuses the project whose origin is the same repository in another spelling", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const first = arrives(daemon, "https://github.com/acme/weather");
  for (const spelling of [
    "github.com:acme/weather.git",
    "git@GitHub.com:acme/weather.git",
    "ssh://git@github.com:22/acme/weather.git/",
  ]) {
    const again = arrives(daemon, spelling);
    expect(again).toMatchObject({ reused: true, workspaceId: first.workspaceId });
  }
});

test("another owner or path case is a different repository, so a new project lands", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const first = arrives(daemon, "git@github.com:acme/weather.git");
  for (const other of ["git@github.com:Acme/Weather.git", "git@github.com:other/weather.git"]) {
    const landed = arrives(daemon, other);
    expect(landed.reused).toBe(false);
    expect(landed.workspaceId).not.toBe(first.workspaceId);
  }
});
