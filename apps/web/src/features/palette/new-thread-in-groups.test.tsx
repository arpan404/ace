import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(cleanup);

const P = "11111111-1111-4111-8111-111111111111";
const weather = "https://github.com/acme/weather.git";

type Daemon = ReturnType<typeof harness>["daemon"];

/** Adds a checkout of `origin` at `path` on one machine and returns its project id. */
function add(daemon: Daemon, home: string, path: string, origin = weather): string {
  daemon.projects.seedFolders(home, [{ path, git: true, remote: origin }]);
  const result = daemon.projects.command({ type: "workspace.add", path });
  if (!result?.ok || !result.workspace) throw new Error("not added");
  return result.workspace.id;
}

/** This Mac and a build server, each with a checkout of the weather repository. */
function world(options: { linked: boolean; projectIdentity?: false }) {
  const made = harness({
    machines: [
      {
        hostId: "build",
        name: "Build server",
        ...(options.projectIdentity === false ? { projectIdentity: false as const } : {}),
      },
    ],
  });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  const here = add(made.daemon, "/Users/dev", "/Users/dev/code/weather");
  const there = add(build, "/home/ci", "/home/ci/weather");
  if (options.linked) {
    made.daemon.projects.identities.set(here, P);
    build.projects.identities.set(there, P);
  }
  return { made, build, here, there };
}

async function openStep(made: ReturnType<typeof harness>) {
  await made.open("/");
  return reopenStep();
}

/** "New thread in…" from the palette, which lists it however many machines are online. */
async function reopenStep() {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await screen.findByRole("combobox", { name: "Search commands" });
  await userEvent.keyboard("new thread in");
  await userEvent.click(await screen.findByRole("option", { name: /^New thread in…/ }));
  return screen.findByRole("dialog", { name: "New thread in" });
}

/** The rows as read aloud, without the chat first and Add project last. */
async function projectRows(step: HTMLElement): Promise<string[]> {
  const list = await within(step).findByRole("listbox", { name: "Projects" });
  return within(list)
    .getAllByRole("option")
    .map((option) => {
      const spoken = option.cloneNode(true) as HTMLElement;
      for (const hidden of spoken.querySelectorAll("[aria-hidden]")) hidden.remove();
      return spoken.textContent ?? "";
    })
    .filter((row) => row !== "No project" && !row.startsWith("Add project"));
}

test("with several machines, New thread in lists every machine's projects", async () => {
  const { made } = world({ linked: false });
  const step = await openStep(made);
  expect(within(step).getByRole("button", { name: "Machine: All machines" })).toBeTruthy();
  // The same origin on two machines, not linked: two projects, never grouped on its own.
  await waitFor(async () =>
    expect(await projectRows(step)).toEqual(["weatherThis Mac", "weatherBuild server"]),
  );
});

test("a linked project is one row, and its checkouts name their machine and folder", async () => {
  const { made, build, there } = world({ linked: true });
  const step = await openStep(made);
  await waitFor(async () =>
    expect(await projectRows(step)).toEqual(["weatherThis Mac · Build server"]),
  );
  await userEvent.click(within(step).getByRole("option", { name: /^weather/ }));
  const checkouts = await within(step).findByRole("listbox", { name: "Checkouts" });
  const names = within(checkouts)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  // This machine's checkout is the default, so it comes first.
  expect(names[0]).toMatch(/^This Mac · \/Users\/dev\/code\/weather/);
  expect(names[1]).toMatch(/^Build server · \/home\/ci\/weather/);
  // Each checkout reads its repository once the step opens.
  await waitFor(() =>
    expect(within(checkouts).getAllByText(/github\.com\/acme\/weather/)).toHaveLength(2),
  );
  await userEvent.click(within(checkouts).getByRole("option", { name: /^Build server/ }));
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Project: weather" })).toBeTruthy();
  expect(build.projects.get(there)?.name).toBe("weather");
});

test("two checkouts of one project on one machine both stay selectable, the last used first", async () => {
  const { made, here } = world({ linked: true });
  const second = add(made.daemon, "/Users/dev", "/Users/dev/work/weather-2");
  made.daemon.projects.identities.set(second, P);
  made.daemon.projects.touch(second, 5_000_000);
  const step = await openStep(made);
  await waitFor(async () => expect(await projectRows(step)).toHaveLength(1));
  await userEvent.click(within(step).getByRole("option", { name: /^weather/ }));
  const checkouts = await within(step).findByRole("listbox", { name: "Checkouts" });
  const options = within(checkouts).getAllByRole("option");
  const texts = options.map((option) => option.textContent ?? "");
  // The default, this machine's most recently used, first; every checkout after it.
  expect(texts[0]).toMatch(/^This Mac · \/Users\/dev\/work\/weather-2/);
  expect(texts.slice(1).toSorted()).toEqual([
    expect.stringMatching(/^Build server · \/home\/ci\/weather/),
    expect.stringMatching(/^This Mac · \/Users\/dev\/code\/weather/),
  ]);
  for (const option of options) expect(option.getAttribute("aria-disabled")).not.toBe("true");
  expect(here).not.toBe(second);
});

test("a project only an offline machine has stays listed, marked offline, and can't be chosen", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = made.machines.get("build");
  if (!build) throw new Error("no build server");
  add(made.daemon, "/Users/dev", "/Users/dev/code/weather");
  add(build, "/home/ci", "/home/ci/api", "https://github.com/acme/api.git");
  const step = await openStep(made);
  await waitFor(async () => expect(await projectRows(step)).toContain("apiBuild server"));
  // The build server goes away: its last list stays, marked offline.
  made.crashMachine("build");
  const api = await within(step).findByRole("option", { name: /^api.*Offline$/ });
  expect(api.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(api);
  expect(within(step).queryByRole("listbox", { name: "Checkouts" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "New thread in" })).toBeTruthy();
});

test("an offline checkout of a linked project is listed but is never the default or chosen", async () => {
  const { made } = world({ linked: true });
  const second = add(made.daemon, "/Users/dev", "/Users/dev/work/weather-2");
  made.daemon.projects.identities.set(second, P);
  const step = await openStep(made);
  await waitFor(async () => expect(await projectRows(step)).toHaveLength(1));
  await userEvent.click(within(step).getByRole("option", { name: /^weather/ }));
  const checkouts = await within(step).findByRole("listbox", { name: "Checkouts" });
  made.crashMachine("build");
  const offline = await within(checkouts).findByRole("option", { name: /^Build server.*Offline$/ });
  expect(offline.getAttribute("aria-disabled")).toBe("true");
  expect(within(checkouts).getAllByRole("option")[0]?.textContent).toMatch(/^This Mac/);
});

test("an older machine's projects list on their own, and still open there", async () => {
  const { made } = world({ linked: false, projectIdentity: false });
  const step = await openStep(made);
  await waitFor(async () =>
    expect(await projectRows(step)).toEqual(["weatherThis Mac", "weatherBuild server"]),
  );
  await userEvent.click(within(step).getByRole("option", { name: /^weather.*Build server$/ }));
  expect(await screen.findByRole("button", { name: "Machine: Build server" })).toBeTruthy();
});

test("picking one machine in the step lists only its projects, and is kept for next time", async () => {
  const { made } = world({ linked: true });
  let step = await openStep(made);
  await userEvent.click(within(step).getByRole("button", { name: "Machine: All machines" }));
  await userEvent.click(await within(step).findByRole("option", { name: "Build server" }));
  await waitFor(async () => expect(await projectRows(step)).toEqual(["weather"]));
  await userEvent.keyboard("{Escape}");
  step = await reopenStep();
  expect(
    within(step).getByRole("button", { name: /^Machine: (This Mac|Build server)$/ }),
  ).toBeTruthy();
  // All machines is the list's first row, and choosing it lists every machine's again.
  await userEvent.click(within(step).getByRole("button", { name: /^Machine:/ }));
  await userEvent.click(await within(step).findByRole("option", { name: "All machines" }));
  await waitFor(async () => expect(await projectRows(step)).toHaveLength(1));
  expect(within(step).getByRole("button", { name: "Machine: All machines" })).toBeTruthy();
});
