import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { fillPages } from "./use-panel-rows.ts";

const P = "11111111-1111-4111-8111-111111111111";

type Made = ReturnType<typeof harness>;
type Daemon = Made["daemon"];

/** Adds a checkout of `origin` at `path` on one machine and returns its project id. */
function add(daemon: Daemon, path: string): string {
  daemon.projects.seedFolders(path.slice(0, path.lastIndexOf("/")), [
    { path, git: true, remote: "https://github.com/acme/api.git" },
  ]);
  const result = daemon.projects.command({ type: "workspace.add", path });
  if (!result?.ok || !result.workspace) throw new Error("not added");
  return result.workspace.id;
}

/** `count` settled threads on this machine, all in a project other than the one filtered to. */
async function history(made: Made, count: number) {
  const scenario = workbench().find((entry) => entry.thread.id === "thread-bump-codex");
  if (!scenario) throw new Error("Missing done scenario");
  await made.client.start();
  for (let i = 0; i < count; i++) {
    const id = `history-${i}`;
    made
      .play({ ...scenario, thread: { ...scenario.thread, id, title: `Finished history ${i}` } })
      .runUntilBlocked();
    await made.client.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
  }
}

/** Opens Home filtered to `project` across every device, counting this daemon's older pages. */
async function openFiltered(made: Made, project: string) {
  made.storage.setItem("ace.home.organizer", JSON.stringify({ baseline: 0, project }));
  const pages = vi.spyOn(made.client, "threadsMore");
  await made.open("/new");
  await screen.findByRole("navigation", { name: "Projects" });
  return pages;
}

/** Long enough for any page the panel would ask for by itself to have been asked for. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));

test("a project only another machine has never pages this machine's history", async () => {
  const made = harness({
    storage: memoryKeyValue(),
    machines: [{ hostId: "build", name: "Build server" }],
  });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  const api = add(build, "/home/ci/api");
  await history(made, 45);
  const pages = await openFiltered(made, `build/${api}`);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Project filter: api/ })).toBeTruthy(),
  );
  await quiet();
  expect(pages).not.toHaveBeenCalled();
});

test("a filter the daemon can't narrow to fills a page from a few of its pages, not all", async () => {
  const made = harness({ storage: memoryKeyValue() });
  // Two checkouts of one project here: this daemon's list can't be narrowed to either.
  const first = add(made.daemon, "/Users/dev/code/api");
  const second = add(made.daemon, "/Users/dev/work/api");
  made.daemon.projects.identities.set(first, P);
  made.daemon.projects.identities.set(second, P);
  await history(made, 110);
  const pages = await openFiltered(made, first);
  await waitFor(() => expect(pages).toHaveBeenCalledTimes(fillPages));
  await quiet();
  expect(pages).toHaveBeenCalledTimes(fillPages);
});
