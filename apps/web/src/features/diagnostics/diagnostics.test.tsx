import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openDevices } from "@/test/device-browser.ts";
afterEach(() => vi.restoreAllMocks());
test("Run checks shows results and a next step for an agent needing attention", async () => {
  await harness({ throughWorker: true }).open("/settings/advanced");
  await userEvent.click(await screen.findByRole("button", { name: "Run checks" }));
  const results = await screen.findByRole("list", { name: "Check results" });
  expect(within(results).getAllByText("Passed")).toHaveLength(3);
  expect(within(results).getByText("Needs attention")).toBeTruthy();
  expect(within(results).getByText(/Open Settings › Providers to check Cursor/)).toBeTruthy();
});
test("support export excludes conversations by default and downloads the chosen contents", async () => {
  const app = harness({ throughWorker: true });
  const downloaded: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) downloaded.push(blob);
    return "blob:support";
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await app.open("/settings/advanced");
  for (const include of [false, true]) {
    downloaded.length = 0;
    await userEvent.click(await screen.findByRole("button", { name: "Export support bundle…" }));
    const dialog = await screen.findByRole("dialog", { name: "Export support bundle" });
    const checkbox = within(dialog).getByRole("checkbox", { name: "Include conversations" });
    if (include) await userEvent.click(checkbox);
    else expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(downloaded.length).toBe(1));
    expect(await downloaded[0]?.text()).toContain(
      include ? "with conversations" : "without conversations",
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Export support bundle" })).toBeNull(),
    );
  }
});
test("Setup explains how to install the connected computer's missing device tools", async () => {
  await harness().open("/setup");
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  const tools = await screen.findByRole("region", { name: "Computer tools" });
  expect(await within(tools).findByText(/Install Xcode from the App Store/)).toBeTruthy();
  expect(within(tools).getByText(/Install Android Studio/)).toBeTruthy();
  expect(within(tools).getByText("Git")).toBeTruthy();
});
test("Devices shows toolchain hints before enabling devices and in the catalog", async () => {
  const { panel } = await openDevices();
  expect(await within(panel).findByText(/Install Xcode from the App Store/)).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Enable devices" }));
  expect(await within(panel).findByRole("list", { name: "Devices" })).toBeTruthy();
  expect(within(panel).getByText(/Install Android Studio/)).toBeTruthy();
});

test("a failed check offers a retry and a failed export keeps the dialog open", async () => {
  const app = harness();
  app.daemon.failRequests("diagnostics.request", "files.request");
  await app.open("/settings/advanced");
  await userEvent.click(await screen.findByRole("button", { name: "Run checks" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't finish the checks. Reconnect to this computer and try again.",
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Run checks" }).disabled).toBe(
    false,
  );
  await userEvent.click(screen.getByRole("button", { name: "Export support bundle…" }));
  const dialog = await screen.findByRole("dialog", { name: "Export support bundle" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Export" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty(
    "textContent",
    "Couldn't export the support bundle. Reconnect to this computer and try again.",
  );
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Export" }).disabled).toBe(
    false,
  );
});
