import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

await import("./agents-page.tsx");

test("mark unresponsive after defaults to 5 minutes and updates the daemon setting", async () => {
  const app = harness();
  await app.open("/settings/agents");
  const select = await screen.findByRole("combobox", { name: "Mark unresponsive after" });
  expect(select.textContent).toContain("5 minutes");

  await userEvent.click(select);
  await userEvent.click(await screen.findByRole("option", { name: "15 minutes" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.unresponsiveAfter")).toBe("15m"),
  );

  await userEvent.click(screen.getByRole("combobox", { name: "Mark unresponsive after" }));
  await userEvent.click(await screen.findByRole("option", { name: "2 minutes" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.unresponsiveAfter")).toBe("2m"),
  );
});
