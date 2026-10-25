import { longHistory, ScenarioPlayer, type FakeDaemon } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });
afterEach(cleanup);

/** This Mac and a build server, the build server running the router thread. */
function onBuild(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }], history });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  new ScenarioPlayer(build, longHistory(2)).runUntilBlocked();
  return { made, build, history };
}

const forksOf = (daemon: FakeDaemon) => {
  const view = daemon.snapshot({ kind: "threads" });
  return Object.values(view?.kind === "threads" ? view.threads : {}).filter(
    (entry) => entry.lineage?.parentThreadId === "thread-router",
  );
};

test("another machine's thread names its machine in the header", async () => {
  const { made } = onBuild("/t/thread-router?machine=build");
  await made.open("/t/thread-router?machine=build");
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  const banner = within(screen.getByRole("banner"));
  expect(await banner.findByText("Build server")).toBeTruthy();
  expect(banner.getByText("docs-site")).toBeTruthy();
});

test("a thread on this machine doesn't name a machine in its header", async () => {
  const { made } = onBuild("/t/thread-router");
  made.play(longHistory(2)).runUntilBlocked();
  await made.open("/t/thread-router");
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  const banner = within(screen.getByRole("banner"));
  await banner.findByText("docs-site");
  expect(banner.queryByText("Build server")).toBeNull();
  expect(banner.queryByText("This Mac")).toBeNull();
});

test("forking another machine's thread forks it there and opens the fork on that machine", async () => {
  const { made, build, history } = onBuild("/t/thread-router?machine=build");
  await made.open("/t/thread-router?machine=build");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(/Answer 1: route 1/, {}, { timeout: 10000 });
  const forkHere = within(feed).getAllByRole("button", { name: "Fork from here" })[0];
  if (!forkHere) throw new Error("No finished answer to fork");
  await userEvent.click(forkHere);

  await screen.findByRole("heading", { level: 1, name: "Document the router (fork)" });
  expect(history.location.search).toContain("machine=build");
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Try nested routes instead{Enter}",
  );

  await waitFor(() => expect(forksOf(build)).toHaveLength(1));
  expect(forksOf(made.daemon)).toEqual([]);
  // The new fork opens on the build server too.
  await waitFor(() =>
    expect(decodeURIComponent(history.location.pathname)).toBe(`/t/${forksOf(build)[0]?.id}`),
  );
  expect(history.location.search).toContain("machine=build");
});
