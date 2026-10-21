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
