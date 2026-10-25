import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

/**
 * This Mac's weather thread and the build server's api thread, both "Add rate limits" and
 * under the same id.
 */
function world() {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }], history });
  made.daemon.projects.seedFolders("/Users/dev", [{ path: "/Users/dev/code/weather", git: true }]);
  made.daemon.projects.command({ type: "workspace.add", path: "/Users/dev/code/weather" });
  const weather = made.daemon.projects.list().workspaces[0];
  const build = made.machines.get("build");
  if (!weather || !build) throw new Error("no machines");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/services/api", git: true }]);
  build.projects.command({ type: "workspace.add", path: "/home/ci/services/api" });
  const api = build.projects.list().workspaces[0];
  if (!api) throw new Error("no api project");
  const thread = { id: "thread-limits", provider: "claude", hasSentMessage: true } as const;
  made.daemon.createThread({ ...thread, workspaceId: weather.id, title: "Add rate limits" });
  build.createThread({
    ...thread,
    workspaceId: api.id,
    title: "Add rate limits",
    details: { workspace: api },
  });
  return { made, history };
}

const options = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");

test("⌘K finds another machine's thread, named with its machine, and opens it there", async () => {
  const { made, history } = world();
  await made.open("/");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.type(search, "rate limits");

  // Two results for the one id: this Mac's unmarked, the build server's named after its project.
  await waitFor(() => {
    const found = options().filter((option) => option.startsWith("Add rate limits"));
    expect(found).toHaveLength(2);
    expect(found).toContainEqual(expect.stringContaining("api · Build server"));
    expect(found.filter((option) => option.includes("Build server"))).toHaveLength(1);
  });
  const theirs = screen
    .getAllByRole("option")
    .find((option) => option.textContent?.includes("Build server"));
  if (!theirs) throw new Error("no Build server result");
  await userEvent.click(theirs);

  await waitFor(() =>
    expect(`${history.location.pathname}${history.location.search}`).toBe(
      "/t/thread-limits?machine=build",
    ),
  );
  expect(await screen.findByRole("heading", { level: 1, name: "Add rate limits" })).toBeTruthy();
});

test("typing a machine's name finds its threads", async () => {
  const { made } = world();
  await made.open("/");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Search commands" }),
    "build server",
  );
  await waitFor(() =>
    expect(options()).toContainEqual(expect.stringMatching(/^Add rate limitsapi · Build server/)),
  );
  expect(options().filter((option) => option.startsWith("Add rate limits"))).toHaveLength(1);
});
