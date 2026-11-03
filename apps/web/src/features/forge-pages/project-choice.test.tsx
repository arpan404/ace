import { seedForgeBrowse, seedProjectForge, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

/** The design's world: ace's pull requests, issues and notifications, and docs-site's. */
function withProjects() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  seedProjectForge(app.daemon, Date.now());
  return app;
}

/** Each row of a list, as one line of its words. */
async function rowTexts(list: "Pull requests" | "Issues" | "Notifications") {
  const nav = await screen.findByRole("navigation", { name: list });
  return within(nav)
    .getAllByRole("listitem")
    .filter((item) => item.querySelector("[data-view-row]"))
    .map((item) => item.textContent ?? "");
}
const rowOf = async (list: "Pull requests" | "Issues" | "Notifications", title: string) =>
  (await rowTexts(list)).find((text) => text.includes(title));

const projectsButton = () => screen.findByRole("button", { name: /^Projects:/ });
async function openProjects() {
  await userEvent.click(await projectsButton());
  return within(await screen.findByRole("group", { name: "Projects" }));
}
const panelLink = (name: string) =>
  within(screen.getByRole("complementary", { name: "Code review" })).getByRole("link", { name });

test("pull requests from every project show by default, each row naming its project", async () => {
  const app = withProjects();
  await app.open("/pulls");
  expect((await projectsButton()).textContent).toContain("All projects");
  await waitFor(async () => {
    expect(await rowOf("Pull requests", "Reconnect the client worker")).toContain("ace");
    expect(await rowOf("Pull requests", "Fix broken links in the CLI reference")).toContain(
      "docs-site",
    );
  });
});

test("ticking projects narrows the list to them; with one, rows drop their project", async () => {
  const app = withProjects();
  const user = userEvent.setup();
  await app.open("/pulls");
  const menu = await openProjects();
  await user.click(menu.getByRole("checkbox", { name: /docs-site/ }));
  await waitFor(async () =>
    expect((await projectsButton()).getAttribute("aria-label")).toBe("Projects: docs-site"),
  );
  await waitFor(async () =>
    expect(await rowOf("Pull requests", "Reconnect the client worker")).toBeUndefined(),
  );
  const links = await rowOf("Pull requests", "Fix broken links in the CLI reference");
  expect(links).not.toContain("docs-site");
  // The menu stays open for the next tick.
  await user.click(menu.getByRole("checkbox", { name: /^ace(\s|\d|$)/ }));
  await waitFor(async () =>
    expect((await projectsButton()).getAttribute("aria-label")).toBe("Projects: ace, docs-site"),
  );
  await waitFor(async () => {
    expect(await rowOf("Pull requests", "Reconnect the client worker")).toContain("ace");
    expect(await rowOf("Pull requests", "Fix broken links in the CLI reference")).toContain(
      "docs-site",
    );
  });
});

test("Only keeps one project, and the choice holds across Issues, Inbox and a reload", async () => {
  const app = withProjects();
  const user = userEvent.setup();
  const view = await app.open("/pulls");
  await user.click((await openProjects()).getByRole("button", { name: "Only docs-site" }));
  await waitFor(async () =>
    expect(await rowOf("Pull requests", "Reconnect the client worker")).toBeUndefined(),
  );
  await user.click(panelLink("Issues"));
  await waitFor(async () =>
    expect((await projectsButton()).getAttribute("aria-label")).toBe("Projects: docs-site"),
  );
  expect(await rowOf("Issues", "Search the docs from the command palette")).toBeTruthy();
  expect(await rowOf("Issues", "Sidebar loses its scroll position")).toBeUndefined();
  await user.click(panelLink("Inbox"));
  await waitFor(async () =>
    expect(await rowOf("Notifications", "Rewrite the install page")).toBeTruthy(),
  );
  // Only docs-site's notifications: ace's review request is left out.
  expect(await rowOf("Notifications", "Reconnect the client worker")).toBeUndefined();
  view.unmount();
  await app.open("/pulls");
  await waitFor(async () =>
    expect((await projectsButton()).getAttribute("aria-label")).toBe("Projects: docs-site"),
  );
  await user.click((await openProjects()).getByRole("checkbox", { name: "All projects" }));
  await waitFor(async () =>
    expect(await rowOf("Pull requests", "Reconnect the client worker")).toBeTruthy(),
  );
});

test("open pull requests across projects group by who has the next move, with honest counts", async () => {
  const app = withProjects();
  await app.open("/pulls");
  const nav = await screen.findByRole("navigation", { name: "Pull requests" });
  await waitFor(() =>
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^Needs you\d/)])),
  );
  // A review asked of you is yours to do, said in words.
  expect(await rowOf("Pull requests", "Reconnect the client worker")).toContain("Your review");
  await userEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
  await waitFor(async () =>
    expect(await rowOf("Pull requests", "Pull requests and issues page")).toBeUndefined(),
  );
  expect(await rowOf("Pull requests", "Reconnect the client worker")).toBeTruthy();
});
