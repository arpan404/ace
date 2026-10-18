import { facts } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the hover card shows the model on its own line below the provider", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "hover-model-own-line",
    title: "Model on its own line",
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
    { name: /^Model on its own line/ },
  );
  await userEvent.hover(row);
  const tip = await screen.findByLabelText(/^Details for Model on its own line/);
  const model = within(tip).getByText("Opus 4.1", { exact: true });
  expect(model.getAttribute("aria-label")).toBe("Model: Opus 4.1");
  expect(model.getAttribute("data-model")).toBe("claude-opus-4-1");

  const provider = within(tip).getByText("Claude Code", { exact: true });
  const providerRow = provider.closest("div");
  const modelRow = model.closest("div");
  expect(providerRow).toBeTruthy();
  expect(modelRow).toBeTruthy();
  expect(providerRow).not.toBe(modelRow);
  // The model is not cut into the provider line: the provider row reads alone.
  expect(providerRow?.textContent).not.toContain("Opus 4.1");
  // The model row follows the provider row, so it renders below it.
  expect(providerRow?.compareDocumentPosition(modelRow as Node)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
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
