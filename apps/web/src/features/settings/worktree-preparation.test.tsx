import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Advanced shows each environment's worktree preparation timeout and saves it", async () => {
  const app = harness();
  await app.open("/settings/advanced");
  const field = await screen.findByRole("spinbutton", {
    name: /Preparation timeout in minutes on /,
  });
  await waitFor(() => expect(field).toHaveProperty("value", "10"));

  await userEvent.clear(field);
  await userEvent.type(field, "15{Enter}");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("worktree.preparationTimeoutMs")).toBe(900_000),
  );
  expect(field).toHaveProperty("value", "15");

  await userEvent.clear(field);
  await userEvent.type(field, "0{Enter}");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Use 1 to 60 minutes.");
  expect(app.daemon.services.settings.get("worktree.preparationTimeoutMs")).toBe(900_000);
});
