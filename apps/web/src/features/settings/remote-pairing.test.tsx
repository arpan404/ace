import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => vi.useRealTimers());

test("a device that scans the code turns the dialog into a confirmation with Done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const app = harness({ clock: () => Date.now() });
  await app.open("/settings/remote");
  await user.click(await screen.findByRole("button", { name: "Pair" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await user.click(within(dialog).getByRole("button", { name: "Show pairing code" }));
  await within(dialog).findByRole("img", { name: "Pairing QR code" });
  // The link sits in a field that never pushes the dialog wider than itself.
  expect(within(dialog).getByRole("textbox", { name: "Pairing link" })).toBeTruthy();

  app.daemon.access.completePairing("Pixel 9");
  await vi.advanceTimersByTimeAsync(2_000);

  expect(await within(dialog).findByText("Pixel 9 paired")).toBeTruthy();
  expect(within(dialog).getByText("Read, Operate")).toBeTruthy();
  const done = within(dialog).getByRole("button", { name: "Done" });
  await waitFor(() => expect(document.activeElement).toBe(done));
  await user.click(done);
  const devices = await screen.findByRole("region", { name: "Paired devices" });
  expect(within(devices).getByText("Pixel 9")).toBeTruthy();
});

test("the chosen access shows above the code, and Change goes back to choose again", async () => {
  await harness({ clock: () => Date.now() }).open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await userEvent.click(within(dialog).getByRole("button", { name: "View only" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Show pairing code" }));
  expect(await within(dialog).findByText("Read")).toBeTruthy();

  await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));
  expect(within(dialog).getByRole("button", { name: "Show pairing code" })).toBeTruthy();
});
