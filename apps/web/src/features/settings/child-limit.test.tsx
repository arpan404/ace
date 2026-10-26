import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

await import("./agents-page.tsx");

test("delegated agents run without a limit until the person sets one, and clearing it removes the limit", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const select = await screen.findByRole("combobox", { name: "Agents a thread runs at once" });
  expect(select.textContent).toContain("No limit");
  expect(screen.getByText("Agents a thread hands work to all start at once.")).toBeTruthy();

  await userEvent.click(select);
  await userEvent.click(await screen.findByRole("option", { name: "4" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("agents.maxRunningChildren")).toBe(4),
  );
  expect(
    await screen.findByText("More agents a thread hands work to wait and start as these finish."),
  ).toBeTruthy();

  await userEvent.click(screen.getByRole("combobox", { name: "Agents a thread runs at once" }));
  await userEvent.click(await screen.findByRole("option", { name: "No limit" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("agents.maxRunningChildren")).toBeNull(),
  );
});
