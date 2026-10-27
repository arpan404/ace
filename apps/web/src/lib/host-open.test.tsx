import { coldStartReplay, FakeDaemon, type SkillSeed } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fallback } from "@/boot/connection.tsx";
import { harness } from "@/test/harness.tsx";
import { hostPathLike, skillHostFolderTarget, skillHostOpenTarget } from "./host-open.ts";

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());
await import("@/features/skills/skill-page.tsx");

test("host paths are absolute, home-relative or a Windows drive; checkout paths are not", () => {
  expect(hostPathLike("/etc/hosts")).toBe(true);
  expect(hostPathLike("~/skills/x")).toBe(true);
  expect(hostPathLike("~")).toBe(false);
  expect(hostPathLike("C:\\skills\\x")).toBe(true);
  expect(hostPathLike("C:/skills/x")).toBe(true);
  expect(hostPathLike("src/relay/socket.ts")).toBe(false);
  expect(hostPathLike("../outside.ts")).toBe(false);
});

test("a skill opens in its project, by its host path when personal, and never for a plugin", () => {
  expect(skillHostOpenTarget({ scope: "project", path: ".claude/skills/x" }, "ws")).toEqual({
    workspaceId: "ws",
    path: ".claude/skills/x/SKILL.md",
  });
  expect(skillHostOpenTarget({ scope: "project", path: ".claude/skills/x" }, undefined)).toBeNull();
  expect(skillHostOpenTarget({ scope: "personal", path: "~/.agents/skills/x" }, undefined)).toEqual(
    { hostPath: "~/.agents/skills/x/SKILL.md" },
  );
  expect(
    skillHostOpenTarget({ scope: "personal", path: "relative/skills/x" }, undefined),
  ).toBeNull();
  expect(
    skillHostOpenTarget({ scope: "plugin", path: "~/.agents/skills/x" }, undefined),
  ).toBeNull();
});

test("a skill's folder is its own directory, and never a plugin's", () => {
  expect(skillHostFolderTarget({ scope: "project", path: ".claude/skills/x" }, "ws")).toEqual({
    workspaceId: "ws",
    path: ".claude/skills/x",
  });
  expect(
    skillHostFolderTarget({ scope: "personal", path: "~/.agents/skills/x" }, undefined),
  ).toEqual({ hostPath: "~/.agents/skills/x" });
  expect(
    skillHostFolderTarget({ scope: "plugin", path: "~/.agents/skills/x" }, undefined),
  ).toBeNull();
  expect(skillHostFolderTarget({ scope: "builtin", path: "/ace/skills/x" }, undefined)).toBeNull();
});

const seeds: SkillSeed[] = [
  {
    name: "research",
    description: "Investigate a question against primary sources.",
    body: "# Research\n\nUse it well.\n",
    scope: "personal",
    links: ["claude"],
  },
];

/** The app against another machine's daemon: opens happen there, through `host.open`. */
function remoteHarness() {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  const connection = {
    ...fallback,
    mode: "daemon" as const,
    url: "http://192.168.1.20:4242/",
    endpoint: {
      kind: "daemon" as const,
      target: { url: "ws://192.168.1.20:4242/", token: daemon.token },
      deviceId: "test-device",
    },
  };
  return { app: harness({ daemon, connection }), daemon };
}

const catalog = () => screen.getByRole("navigation", { name: "Skills catalog" });

async function openResearch() {
  await userEvent.click(within(catalog()).getByRole("link", { name: /^Research/ }));
  await screen.findByRole("heading", { level: 2, name: "Research" });
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open in editor" }));
}

test("a personal skill opens by its host path on another machine", async () => {
  const { app, daemon } = remoteHarness();
  daemon.skills.seed(seeds);
  await app.open("/skills");
  await screen.findByRole("navigation", { name: "Skills catalog" });
  await openResearch();

  const reply = await app.client.request({ type: "skills.request", operation: { op: "list" } });
  const entry =
    reply.result.kind === "list"
      ? reply.result.entries.find((skill) => skill.name === "research")
      : undefined;
  if (!entry) throw new Error("missing skill");
  await waitFor(() =>
    expect(daemon.workspace.opened).toContainEqual({
      app: "code",
      folder: "host",
      path: `${entry.path}/SKILL.md`,
    }),
  );
});

test("a host path outside every project says only the owner can open it", async () => {
  const { app, daemon } = remoteHarness();
  daemon.skills.seed(seeds);
  await app.open("/skills");
  await screen.findByRole("navigation", { name: "Skills catalog" });
  const listed = await app.client.request({
    type: "skills.request",
    operation: { op: "list" },
  });
  const entry =
    listed.result.kind === "list"
      ? listed.result.entries.find((skill) => skill.name === "research")
      : undefined;
  if (!entry) throw new Error("missing skill");
  daemon.workspace.setOwnerOnlyHostPaths([entry.path]);
  await openResearch();

  const toasts = within(await screen.findByRole("region", { name: "Notifications" }));
  expect(await toasts.findByText("Only the machine's owner can open this.")).toBeTruthy();
  expect(daemon.workspace.opened).toEqual([]);
});

test("a checkout file opens on another machine instead of this device", async () => {
  const { app, daemon } = remoteHarness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  const launched = vi.spyOn(window, "open").mockImplementation(() => null);
  try {
    await userEvent.keyboard("{Control>}p{/Control}");
    await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "sock");
    await userEvent.keyboard("{Enter}");
    const side = await screen.findByRole("region", { name: "Thread panel" });
    const launch = await within(side).findByRole("button", {
      name: "Open in Visual Studio Code",
    });
    await userEvent.click(launch);
    await waitFor(() =>
      expect(daemon.workspace.opened).toContainEqual({
        app: "code",
        folder: "thread-cold-start",
        path: "apps/web/src/relay/socket.ts",
      }),
    );
    expect(launched).not.toHaveBeenCalled();
  } finally {
    launched.mockRestore();
  }
});
