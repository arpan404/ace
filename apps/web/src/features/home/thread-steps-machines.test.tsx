import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

/**
 * Two threads on This Mac, "Trim the cache" and "Rotate the logs", and "Add rate limits" on the
 * build server, which shares its id with "Rotate the logs".
 */
function world() {
  const history = createMemoryHistory({ initialEntries: ["/t/thread-cache"] });
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
  const here = { workspaceId: weather.id, provider: "claude", hasSentMessage: true } as const;
  made.daemon.createThread({ ...here, id: "thread-cache", title: "Trim the cache" });
  made.daemon.createThread({ ...here, id: "thread-shared", title: "Rotate the logs" });
  build.createThread({
    id: "thread-shared",
    workspaceId: api.id,
    title: "Add rate limits",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace: api },
  });
  return { made, history };
}

const where = (history: ReturnType<typeof createMemoryHistory>) =>
  `${history.location.pathname}${history.location.search}`;

async function step(key: "ArrowDown" | "ArrowUp", title: string) {
  await userEvent.keyboard(`{Alt>}{Meta>}{${key}}{/Meta}{/Alt}`);
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
}

const rowTitles = (list: HTMLElement) =>
  within(list)
    .getAllByRole("link")
    .map((link) => (link.getAttribute("aria-label") ?? "").split(".")[0] ?? "");

const address: Record<string, string> = {
  "Trim the cache": "/t/thread-cache",
  "Rotate the logs": "/t/thread-shared",
  "Add rate limits": "/t/thread-shared?machine=build",
};

test("⌥⌘↓ and ⌥⌘↑ step through another machine's thread in Home's order and back", async () => {
  const { made, history } = world();
  await made.open("/");
  const threads = await screen.findByRole("list", { name: "Threads" });
  await waitFor(() => expect(rowTitles(threads)).toHaveLength(3));
  // Whatever order Home settles on, the steps follow it, the build server's thread included.
  const order = rowTitles(threads);
  const [first] = order;
  if (!first) throw new Error("no rows");
  await userEvent.click(within(threads).getByRole("link", { name: new RegExp(`^${first}`) }));
  await screen.findByRole("heading", { level: 1, name: first });

  for (const title of order.slice(1)) {
    await step("ArrowDown", title);
    await waitFor(() => expect(where(history)).toBe(address[title]));
  }
  // Back up from the last, finding each one's place, the build server's by its machine.
  for (const title of order.slice(0, -1).toReversed()) {
    await step("ArrowUp", title);
    await waitFor(() => expect(where(history)).toBe(address[title]));
  }
});
