import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the worktree settings explain worktree isolation and still allow changing it", async () => {
  await harness().open("/settings/agents");
  const toggle = await screen.findByRole("switch", { name: "New threads use a worktree" });
  const worktrees = screen.getByRole("region", { name: "Worktrees" });
  expect(within(worktrees).getByRole("switch", { name: "New threads use a worktree" })).toBe(toggle);
  await within(worktrees).findByText(
    "Start new threads in separate Git worktrees so their changes stay isolated.",
  );
  const before = toggle.getAttribute("aria-checked");
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).not.toBe(before);
});

test("provider switching is explained separately from defaults for new threads", async () => {
  await harness().open("/settings/agents");
  const switching = await screen.findByRole("region", { name: "Switching providers" });
  expect(
    within(switching).getByText(
      "Create a new thread when changing providers. The original conversation stays unchanged.",
    ),
  ).toBeTruthy();
  expect(
    within(switching).getByRole("switch", { name: "Fork when switching providers" }),
  ).toBeTruthy();
});
