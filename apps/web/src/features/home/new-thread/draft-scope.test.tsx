import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { preparationKey, savePreparation } from "./preparations.ts";

const P = "11111111-1111-4111-8111-111111111111";

type Daemon = ReturnType<typeof harness>["daemon"];

function add(daemon: Daemon, path: string, origin: string): string {
  daemon.projects.seedFolders(path.slice(0, path.lastIndexOf("/")), [
    { path, git: true, remote: origin },
  ]);
  const result = daemon.projects.command({ type: "workspace.add", path });
  if (!result?.ok || !result.workspace) throw new Error("not added");
  return result.workspace.id;
}

function draft(
  storage: ReturnType<typeof memoryKeyValue>,
  host: string,
  project: string,
  title: string,
) {
  savePreparation(storage, host, preparationKey(host, project), {
    project,
    choices: { project },
    title,
  });
}

/** This Mac with two checkouts of weather, and a build server with api, which only it has. */
function world() {
  const storage = memoryKeyValue();
  const made = harness({ storage, machines: [{ hostId: "build", name: "Build server" }] });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  const first = add(made.daemon, "/Users/dev/code/weather", "https://github.com/acme/weather.git");
  const second = add(made.daemon, "/Users/dev/work/weather", "https://github.com/acme/weather.git");
  made.daemon.projects.identities.set(first, P);
  made.daemon.projects.identities.set(second, P);
  const api = add(build, "/home/ci/api", "https://github.com/acme/api.git");
  draft(storage, "this-mac", second, "Second checkout draft");
  draft(storage, "build", api, "Build server draft");
  return { made, storage, first, api };
}

test("a project's drafts in its other checkout here are listed under its filter", async () => {
  const { made, storage, first } = world();
  storage.setItem("ace.home.organizer", JSON.stringify({ baseline: 0, project: first }));
  await made.open("/");
  expect(await screen.findByRole("link", { name: /^Second checkout draft\. Draft/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /^Build server draft\./ })).toBeNull();
});

test("a project only another machine has lists its own drafts under its filter", async () => {
  const { made, storage, api } = world();
  storage.setItem("ace.home.organizer", JSON.stringify({ baseline: 0, project: `build/${api}` }));
  await made.open("/");
  expect(await screen.findByRole("link", { name: /^Build server draft\. Draft/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /^Second checkout draft\./ })).toBeNull();
});
