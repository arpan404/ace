import type { FakeDaemon } from "@ace/fake-daemon";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

const P = "11111111-1111-4111-8111-111111111111";

/** This Mac and a build server; the build server may be a daemon from before identity. */
function machines(build: { projectIdentity?: false } = {}) {
  const made = harness({ machines: [{ hostId: "build", name: "Build server", ...build }] });
  const server = made.machines.get("build");
  if (!server) throw new Error("no build server");
  return { made, build: server };
}

/** Registers a checkout of `remote` (or a plain folder) and returns its id. */
function addProject(daemon: FakeDaemon, path: string, remote?: string) {
  daemon.projects.seedFolders(path.slice(0, path.lastIndexOf("/")), [
    { path, git: true, ...(remote ? { remote } : {}) },
  ]);
  const added = daemon.projects.command({ type: "workspace.add", path });
  if (!added?.workspace) throw new Error(`couldn't add ${path}`);
  return added.workspace.id;
}

async function openIn(project: string) {
  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("option", { name: project }));
  await screen.findByRole("button", { name: `Project: ${project}` });
}

test("moving to another machine opens its checkout of the same logical project first", async () => {
  const { made, build } = machines();
  // The person's fork here and the upstream there: different origins, linked by the person.
  const here = addProject(made.daemon, "/Users/dev/code/ace", "git@github.com:me/ace.git");
  const there = addProject(build, "/home/ci/src/ace-upstream", "https://github.com/acme/ace");
  // A checkout of the fork's origin there too, which the older match would have chosen.
  addProject(build, "/home/ci/src/ace-fork", "https://github.com/me/ace");
  made.daemon.projects.identities.set(here, P);
  build.projects.identities.set(there, P);
  await made.open("/new");
  await openIn("ace");
  await userEvent.click(await screen.findByRole("button", { name: "Machine: This Mac" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Build server" }));
  expect(await screen.findByRole("button", { name: "Project: ace-upstream" })).toBeTruthy();
});

test("a machine with two checkouts of the project offers both, and the one chosen opens", async () => {
  const { made, build } = machines();
  const here = addProject(made.daemon, "/Users/dev/code/ace", "https://github.com/acme/ace");
  const main = addProject(build, "/home/ci/src/ace", "https://github.com/acme/ace");
  const review = addProject(build, "/home/ci/review/ace-review", "https://github.com/acme/ace");
  for (const [daemon, id] of [
    [made.daemon, here],
    [build, main],
    [build, review],
  ] as const)
    daemon.projects.identities.set(id, P);
  await made.open("/new");
  await openIn("ace");
  await userEvent.click(await screen.findByRole("button", { name: "Machine: This Mac" }));
  expect(
    await screen.findByRole("menuitemradio", { name: "Build server, /home/ci/src/ace" }),
  ).toBeTruthy();
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "Build server, /home/ci/review/ace-review" }),
  );
  expect(await screen.findByRole("button", { name: "Project: ace-review" })).toBeTruthy();
});

test("an older machine is matched by origin as before, at the same folder", async () => {
  const { made, build } = machines({ projectIdentity: false });
  addProject(made.daemon, "/Users/dev/code/ace", "git@github.com:acme/ace.git");
  addProject(build, "/home/ci/src/ace-main", "https://github.com/acme/ace");
  await made.open("/new");
  await openIn("ace");
  await userEvent.click(await screen.findByRole("button", { name: "Machine: This Mac" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Build server" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Project: ace-main" })).toBeTruthy(),
  );
});
