import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fakeOrgHostId, fakeOrgs } from "@/boot/fake-orgs.ts";
import { harness } from "./harness.tsx";
import { orgBackend } from "./org-backend.ts";

/* A window with a personal machine and an organization's host, for tests of what each space shows. */

export const personalThread = "Tune the weather cache";
export const orgThread = "Add rate limits to the api";

/**
 * This Mac, the person's own machine, with its weather project and a thread there; and the build
 * server, Acme Robotics' host (ADR 0206 §2.4), with its api project and a thread there.
 */
export function world(
  options: { space?: string; acmeHosts?: readonly { hostId: string; name: string }[] } = {},
) {
  const extra = options.acmeHosts ?? [];
  const account = orgBackend({
    ...(options.space ? { space: options.space } : {}),
    hosts: {
      [fakeOrgs.acme]: extra.map((host) => ({ ...host, platform: "linux", lastSeenAt: 0 })),
    },
  });
  const made = harness({
    account: account.backend,
    machines: [{ hostId: fakeOrgHostId, name: "Build server" }, ...extra],
  });
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather", git: true }]);
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/weather" });
  const weather = made.daemon.projects.list().workspaces[0];
  const build = made.machines.get(fakeOrgHostId);
  if (!weather || !build) throw new Error("no machines");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  build.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
  const api = build.projects.list().workspaces[0];
  if (!api) throw new Error("no api project");
  made.daemon.createThread({
    id: "thread-weather",
    provider: "claude",
    hasSentMessage: true,
    workspaceId: weather.id,
    title: personalThread,
  });
  build.createThread({
    id: "thread-api",
    provider: "claude",
    hasSentMessage: true,
    workspaceId: api.id,
    title: orgThread,
    details: { workspace: api },
  });
  return { made, account };
}

export const sidebar = () => screen.findByRole("navigation", { name: "Projects" });
export const sidebarText = async () => (await sidebar()).textContent ?? "";

/** The rail's account mark: the window's space is picked from its menu. */
export async function switchTo(space: RegExp) {
  await userEvent.click(await screen.findByRole("button", { name: /, account/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: space }));
}

/** The project filter's projects, as its menu lists them. */
export async function filterProjects() {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter/ }));
  const menu = await screen.findByRole("menu");
  const names = within(menu)
    .queryAllByRole("menuitemradio")
    .map((item) => item.getAttribute("aria-label") ?? item.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  return names;
}
