import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

/** Width and visibility survive independently, including keyboard-only use. */
test("keyboard resizing survives reload and collapsing restores the saved width", async () => {
  const storage = memoryKeyValue();
  const view = await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  let handle = await screen.findByRole("separator", { name: "Resize sidebar" });
  handle.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(handle.getAttribute("aria-valuenow")).toBe("296");
  view.unmount();
  await harness({ storage }).open("/new");
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  handle = await screen.findByRole("separator", { name: "Resize sidebar" });
  expect(handle.getAttribute("aria-valuenow")).toBe("296");
  handle.focus();
  await userEvent.keyboard("{Enter}");
  const reopen = await screen.findByRole("button", { name: "Reopen sidebar" });
  await waitFor(() =>
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull(),
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show sidebar" }));
  await userEvent.click(reopen);
  handle = await screen.findByRole("separator", { name: "Resize sidebar" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(handle.getAttribute("aria-valuenow")).toBe("296");
  handle.focus();
  await userEvent.keyboard("{Home}{ArrowLeft}");
  expect(handle.getAttribute("aria-valuenow")).toBe("220");
});
