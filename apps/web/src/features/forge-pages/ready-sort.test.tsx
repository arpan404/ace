import { sketchPullRequests, workbench, type PrSketch } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const minute = 60_000;
const waiting = (number: number): PrSketch => ({
  number,
  title: `Waiting change ${number}`,
  state: "open",
  author: "sam",
  reviewers: ["you"],
  decision: "REVIEW_REQUIRED",
  ci: "success",
  updated: number * minute,
  branch: `work/${number}`,
  body: "",
  files: [["src/a.ts", 1, 0]],
});

/** More open pull requests than one page, the only ready one older than every other. */
function withBusyRepository() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.seedPullRequests(
    sketchPullRequests(Date.now(), [
      ...Array.from({ length: 30 }, (_, index) => waiting(index + 1)),
      {
        ...waiting(90),
        title: "Old but ready",
        decision: "APPROVED",
        updated: 30 * 24 * 60 * minute,
      },
    ]),
  );
  return app;
}

async function groups() {
  const nav = await screen.findByRole("navigation", { name: "Pull requests" });
  return Object.fromEntries(
    within(nav)
      .getAllByRole("region")
      .map((section) => [
        section.getAttribute("aria-label"),
        within(section).queryAllByRole("link").length,
      ]),
  );
}

test("a ready pull request older than the first page still leads the list", async () => {
  const app = withBusyRepository();
  await app.open("/pulls?project=ace");
  await waitFor(async () => expect(await groups()).toEqual({ Ready: 1, "Waiting on review": 25 }));
  const ready = within(await screen.findByRole("region", { name: "Ready" }));
  expect(ready.getByRole("link", { name: /Old but ready/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await waitFor(async () => expect(await groups()).toEqual({ Ready: 1, "Waiting on review": 30 }));
});
