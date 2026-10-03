import { flakyCheckout, seedIndex, workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const approvalTitle = "Run rm -rf node_modules/.cache/vitest?";
const card = (name: string) => screen.findByRole("article", { name });
const main = () => screen.getByRole("main");

function workbenchApp() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  return app;
}

test("answering an approval in Activity resolves it and takes it off the rail's needs-you count", async () => {
  const app = harness();
  app.play(flakyCheckout()).runThrough("approval-requested");
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/activity");

  const approval = await card(approvalTitle);
  const rail = screen.getByRole("navigation", { name: "Views" });
  // The approval and the three Deck decisions the Activity feed also holds.
  expect(await within(rail).findByLabelText("4 need you")).toBeTruthy();

  await userEvent.click(within(approval).getByRole("button", { name: "Approve" }));

  await waitFor(() => expect(screen.queryByRole("article", { name: approvalTitle })).toBeNull());
  expect(within(rail).getByLabelText("3 need you")).toBeTruthy();
  expect(await screen.findByText("Approved · the agent continues")).toBeTruthy();

  // The daemon's interaction.closed event, not the click, is what the store now holds.
  const thread = app.client.thread("thread-checkout");
  const resolved = thread.store
    .interactionIds()
    .map((id) => thread.store.interaction(id))
    .find((interaction) => interaction?.request.kind === "approval");
  thread.release();
  expect(resolved).toMatchObject({
    state: "resolved",
    resolution: { kind: "approval", optionId: "allow" },
    resolvedBy: "test-device",
  });
});

test("an approval card shows the command it would run and how risky it is", async () => {
  const app = workbenchApp();
  await app.open("/activity");

  const push = await card("Allow a force push to fix/restart-retry?");
  expect(
    within(push).getByText("git push --force-with-lease origin fix/restart-retry"),
  ).toBeTruthy();
  expect(within(push).getByText("High risk.")).toBeTruthy();
  expect(
    within(push).getByText("Rewrites 6 commits on a branch that PR #188 tracks."),
  ).toBeTruthy();

  const font = await card("Install @fontsource/noto-sans-jp?");
  expect(within(font).getByText("bun add @fontsource/noto-sans-jp@5.1.0")).toBeTruthy();
  expect(within(font).getByText("Medium risk.")).toBeTruthy();
});

test("J and K move between cards and A approves only the focused one", async () => {
  const app = workbenchApp();
  await app.open("/activity");
  const push = await card("Allow a force push to fix/restart-retry?");
  await card("Install @fontsource/noto-sans-jp?");
  await waitFor(() => expect(push.getAttribute("aria-current")).toBe("true"));

  await userEvent.keyboard("jj");
  const font = await card("Install @fontsource/noto-sans-jp?");
  expect(font.getAttribute("aria-current")).toBe("true");
  expect(push.getAttribute("aria-current")).toBeNull();
  await userEvent.keyboard("k");
  expect(
    (await card("How should the sheet recover after rotate?")).getAttribute("aria-current"),
  ).toBe("true");
  await userEvent.keyboard("ja");

  await waitFor(() =>
    expect(app.daemon.isPending("thread-refund-tax", "approve-font")).toBe(false),
  );
  expect(app.daemon.resolution("thread-refund-tax", "approve-font")).toEqual({
    kind: "approval",
    optionId: "allow",
  });
  expect(app.daemon.isPending("thread-retry-budget", "approve-force-push")).toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("article", { name: "Install @fontsource/noto-sans-jp?" })).toBeNull(),
  );
});

test("D denies the focused approval", async () => {
  const app = workbenchApp();
  await app.open("/activity");
  await card("Allow a force push to fix/restart-retry?");
  await waitFor(() =>
    expect(
      screen
        .getByRole("article", { name: "Allow a force push to fix/restart-retry?" })
        .getAttribute("aria-current"),
    ).toBe("true"),
  );

  await userEvent.keyboard("d");

  await waitFor(() =>
    expect(app.daemon.resolution("thread-retry-budget", "approve-force-push")).toEqual({
      kind: "approval",
      optionId: "deny",
    }),
  );
  expect(await screen.findByText("Denied · the agent will ask what to do instead")).toBeTruthy();
});

test("a number key picks that option of the focused question", async () => {
  const app = workbenchApp();
  await app.open("/activity");
  const question = await card("How should the sheet recover after rotate?");
  expect(within(question).getByText("Persist the draft in the view model")).toBeTruthy();
  expect(within(question).getByText("recommended")).toBeTruthy();

  await userEvent.click(within(question).getByText("How should the sheet recover after rotate?"));
  await waitFor(() => expect(question.getAttribute("aria-current")).toBe("true"));
  await userEvent.keyboard("2");

  await waitFor(() =>
    expect(app.daemon.resolution("thread-sheet-rotate", "ask-recovery")).toEqual({
      kind: "question",
      answers: { recovery: ["lock"] },
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "How should the sheet recover after rotate?" }),
    ).toBeNull(),
  );
});

test("ticking Always allow answers with the provider's wider grant", async () => {
  const app = harness();
  app.play(seedIndex()).runUntilBlocked();
  await app.open("/activity");
  const seed = await card("Reseed the docs search index?");
  expect(within(seed).getByText("bun run search:seed --from src/content/docs")).toBeTruthy();

  await userEvent.click(
    within(seed).getByRole("checkbox", { name: "Always allow bun run in docs-site" }),
  );
  await userEvent.click(within(seed).getByRole("button", { name: "Approve" }));

  await waitFor(() =>
    expect(app.daemon.resolution("thread-seed-index", "approve-seed")).toEqual({
      kind: "approval",
      optionId: "always",
    }),
  );
  expect(within(main()).queryByText("Always allow bun run in docs-site")).toBeNull();
});

test("Needs you shows placeholder cards until the thread list arrives, never a false all-clear", async () => {
  const app = workbenchApp();
  await app.open("/activity");
  expect(screen.queryByText("Nothing needs you")).toBeNull();
  expect(await card("How should the sheet recover after rotate?")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Loading requests" })).toBeNull();
});
