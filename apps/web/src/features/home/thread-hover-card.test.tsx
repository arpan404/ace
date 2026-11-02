import { facts } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the hover card names the model without the provider's name", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "hover-model-own-line",
    title: "Model beside the account",
    workspaceId: "ace",
    provider: "claude",
    execution: { provider: "claude", model: "claude-opus-4-1", options: {} },
  });
  app.daemon.apply("hover-model-own-line", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix replay"),
  ]);
  await app.open("/new");
  const row = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: /^Model beside the account/ },
  );
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Model beside the account/);
  const model = within(tip).getByLabelText("Model: Opus 4.1");
  expect(model.getAttribute("data-model")).toBe("claude-opus-4-1");
  // The provider's icon already says who runs it; its name is not repeated.
  expect(tip.textContent).not.toContain("Claude Code");
});

test("the hover card shows no model line when the model is unknown", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "hover-no-model",
    title: "Thread without a model",
    workspaceId: "ace",
    provider: "claude",
  });
  app.daemon.apply("hover-no-model", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix replay"),
  ]);
  await app.open("/new");
  const row = await within(await screen.findByRole("navigation", { name: "Threads" })).findByRole(
    "link",
    { name: /^Thread without a model/ },
  );
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Thread without a model/);
  expect(within(tip).queryByLabelText(/^Model:/)).toBeNull();
});

const threadsList = async () => within(await screen.findByRole("navigation", { name: "Threads" }));

test("a row draws its provider mark with no account bubble; the hover card names the account", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "hover-account",
    title: "Runs on the work account",
    workspaceId: "ace",
    provider: "claude",
    execution: {
      provider: "claude",
      instanceId: "claude-work",
      model: "claude-opus-4-1",
      options: {},
    },
  });
  app.daemon.apply("hover-account", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix replay"),
  ]);
  await app.open("/new");
  const row = await (await threadsList()).findByRole("link", { name: /^Runs on the work account/ });
  expect(within(row).getByRole("img", { name: /^Claude Code/ })).toBeTruthy();
  expect(row.querySelector("[data-account-badge]")).toBeNull();
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Runs on the work account/);
  expect(tip.textContent).toContain("Work");
});

test("the hover card says in words that a thread waits for approval, led by the amber hand", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "hover-asks",
    title: "Publish the release",
    workspaceId: "ace",
    provider: "codex",
  });
  app.daemon.apply("hover-asks", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Publish it."),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "ask",
      blocking: true,
      request: { kind: "approval", title: "Publish?", options: [] },
    },
  ]);
  await app.open("/new");
  const row = await (await threadsList()).findByRole("link", { name: /^Publish the release/ });
  await within(row).findByRole("img", { name: "Needs approval" });
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Publish the release/);
  const sentence = within(tip).getByText("Waiting for approval", { exact: true });
  expect(sentence.closest("[data-ink]")?.getAttribute("data-ink")).toBe("warning");
  expect(within(tip).queryByText("Approval", { exact: true })).toBeNull();
  // The row's own icon leads the line, in the same colour; no word chip.
  const icon = tip.querySelector("[data-hover-status] [data-icon]");
  expect(icon?.getAttribute("data-icon")).toBe("approve");
  expect(icon?.getAttribute("data-tone")).toBe("needs-you");
});

test("the hover card of a failed thread says Failed in red", async () => {
  // The daemon's clock runs ahead of this device's first launch, so the failure is news here.
  let at = Date.now() + 60_000;
  const app = harness({ clock: () => (at = Math.max(at + 1, Date.now() + 60_000)) });
  app.daemon.createThread({
    id: "hover-failed",
    title: "Migrate the billing table",
    workspaceId: "ace",
    provider: "codex",
  });
  app.daemon.apply("hover-failed", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Migrate."),
    facts.endTurn("root", "failed"),
  ]);
  await app.open("/new");
  const row = await (
    await threadsList()
  ).findByRole("link", { name: /^Migrate the billing table/ });
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Migrate the billing table/);
  const sentence = within(tip).getByText("Failed", { exact: true });
  expect(sentence.closest("[data-ink]")?.getAttribute("data-ink")).toBe("destructive");
});
