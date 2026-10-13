import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Storage shows the data window and saves a new one through the daemon", async () => {
  const app = harness();
  await app.open("/settings/storage");
  const days = await screen.findByRole("spinbutton", { name: "Keep data for (days)" });
  await waitFor(() => expect(days).toHaveProperty("value", "120"));
  expect(screen.getByRole("spinbutton", { name: "Log limit (MB)" })).toHaveProperty(
    "value",
    "1024",
  );

  await userEvent.clear(days);
  await userEvent.type(days, "90{Enter}");
  await waitFor(() => expect(app.daemon.services.settings.get("storage.retentionDays")).toBe(90));
  expect(days).toHaveProperty("value", "90");

  await userEvent.clear(days);
  await userEvent.type(days, "0{Enter}");
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Keep data for 1 to 3650 days.",
  );
  expect(app.daemon.services.settings.get("storage.retentionDays")).toBe(90);
});
