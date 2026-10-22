import { expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { pullRequestDetails, workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";
import { openPullRequest } from "./test-support.ts";

const repository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "docs-site",
} as const;

/** PR #31 of acme/docs-site: mira asked for changes, dana commented, ola is still asked. */
async function openInstallPage() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.workspace.seedPullRequests(pullRequestDetails(1_000));
  await openPullRequest(app, { project: "api", repository, number: 31 });
  await screen.findByRole("article", { name: "Pull request #31" }, { timeout: 10_000 });
  return app;
}

const reviewers = () => screen.findByRole("button", { name: /^Reviewers: mira/ });
const list = async () => {
  const button = await reviewers();
  if (button.getAttribute("aria-expanded") !== "true") await userEvent.click(button);
  return screen.findByRole("dialog");
};
const row = async (name: string) =>
  (await within(await list()).findByText(name)).closest("li") as HTMLElement;

test("each reviewer shows their latest review, and a verdict can be dismissed with a reason", async () => {
  await openInstallPage();
  await waitFor(async () =>
    expect((await reviewers()).getAttribute("aria-label")).toBe(
      "Reviewers: mira, Changes requested; dana, Commented; ola, Awaiting review",
    ),
  );
  // A comment has no verdict to take back.
  expect(within(await row("dana")).queryByRole("button", { name: /Dismiss/ })).toBeNull();
  await userEvent.click(
    within(await row("mira")).getByRole("button", { name: "Dismiss mira's review" }),
  );
  const submit = screen.getByRole("button", { name: "Dismiss review" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Why dismiss mira's review" }),
    "The port is fixed",
  );
  await userEvent.click(submit);
  await waitFor(async () => expect(within(await row("mira")).getByText("Dismissed")).toBeTruthy());
}, 30_000);

test("a reviewer is asked again after reviewing, and a pending request can be withdrawn", async () => {
  await openInstallPage();
  await userEvent.click(within(await row("mira")).getByRole("button", { name: "Re-request" }));
  await waitFor(async () =>
    expect(within(await row("mira")).getByText("Changes requested · asked again")).toBeTruthy(),
  );
  await userEvent.click(
    within(await row("ola")).getByRole("button", { name: "Remove ola from reviewers" }),
  );
  await waitFor(async () => expect(within(await list()).queryByText("ola")).toBeNull());
}, 30_000);

test("the request picker offers GitHub's suggestions and Enter asks the ones picked", async () => {
  await openInstallPage();
  await userEvent.click(within(await list()).getByRole("button", { name: "Request review" }));
  const field = await screen.findByRole("textbox", { name: "Reviewers" });
  const suggested = await screen.findByRole("region", { name: "Suggested" });
  await userEvent.click(within(suggested).getByRole("button", { name: "jonas, Jonas Becker" }));
  expect((field as HTMLInputElement).value).toBe("jonas, ");
  expect(document.activeElement).toBe(field);
  await userEvent.type(field, "acme/docs{Enter}");
  await waitFor(async () =>
    expect((await reviewers()).getAttribute("aria-label")).toContain(
      "jonas, Awaiting review; docs, Awaiting review",
    ),
  );
}, 30_000);
