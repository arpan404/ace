import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

afterEach(() => vi.useRealTimers());

test("a device that scans the code turns the dialog into a confirmation with Done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const app = harness({ clock: () => Date.now() });
  await app.open("/settings/remote");
  await user.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await user.click(within(dialog).getByRole("button", { name: "Create link" }));
  await within(dialog).findByRole("img", { name: "Pairing QR code" });
  // The link sits in a field that never pushes the dialog wider than itself.
  expect(within(dialog).getByRole("textbox", { name: "Pairing link" })).toBeTruthy();

  app.daemon.access.completePairing("Pixel 9");
  await vi.advanceTimersByTimeAsync(2_000);

  expect(await within(dialog).findByText("Pixel 9 paired")).toBeTruthy();
  expect(within(dialog).getByText("View and act")).toBeTruthy();
  const done = within(dialog).getByRole("button", { name: "Done" });
  await waitFor(() => expect(document.activeElement).toBe(done));
  await user.click(done);
  const devices = await screen.findByRole("region", { name: "Devices" });
  expect(within(devices).getByText("Pixel 9")).toBeTruthy();
});

test("the chosen access shows above the code, and Change goes back to choose again", async () => {
  await harness({ clock: () => Date.now() }).open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await userEvent.click(within(dialog).getByRole("radio", { name: "View only" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
  expect(await within(dialog).findByText("View only")).toBeTruthy();

  await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));
  expect(within(dialog).getByRole("button", { name: "Create link" })).toBeTruthy();
});

test("pairing explains the actual Tailscale listener instead of asking to enable it again", async () => {
  await harness().open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  expect(
    await within(dialog).findByText(/Connect your device to your Tailscale network to pair/),
  ).toBeTruthy();
  expect(within(dialog).queryByText(/Turn on LAN or Tailscale/)).toBeNull();
});

test("remote access off explains the missing listener and prevents making an unusable code", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "remote.enabled": false });
  await app.open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  expect(await within(dialog).findByText(/Turn on LAN or Tailscale/)).toBeTruthy();
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", { name: "Create link" }).disabled,
  ).toBe(true);
});

test("turning remote access off changes pairing instructions on the same page", async () => {
  await harness().open("/settings/remote");
  // The switch replaces its placeholder once settings load: look it up again after.
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Remote access", checked: true }).hasAttribute("disabled"),
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("switch", { name: "Remote access" }));
  await screen.findByRole("switch", { name: "Remote access", checked: false });
  await userEvent.click(screen.getByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  expect(await within(dialog).findByText(/Turn on LAN or Tailscale/)).toBeTruthy();
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", { name: "Create link" }).disabled,
  ).toBe(true);
}, 30_000);

test("administrator access still requires explicit Projects and Accounts grants, and says what it allows", async () => {
  const app = harness({ clock: () => Date.now() });
  await app.open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await userEvent.click(within(dialog).getByRole("radio", { name: "Administrator" }));
  expect(within(dialog).getByRole("note").textContent).toMatch(/pair and revoke other devices/);
  await userEvent.click(within(dialog).getByText("Advanced access", { exact: true }));
  await userEvent.click(within(dialog).getByRole("switch", { name: "Projects" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
  const link = await within(dialog).findByRole<HTMLInputElement>("textbox", {
    name: "Pairing link",
  });
  expect(new URLSearchParams(new URL(link.value).hash.slice(1)).get("scopes")).toBe(
    "read,operate,admin,projects",
  );
  expect(within(dialog).getByText("Administrator, Projects")).toBeTruthy();
});

test("a named link that lasts an hour pairs a device under that name for the chosen time", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const app = harness({ clock: () => Date.now() });
  await app.open("/settings/remote");
  await user.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await user.type(within(dialog).getByRole("textbox", { name: "Device name" }), "Kitchen iPad");
  await user.click(within(dialog).getByRole("combobox", { name: "Link works for" }));
  await user.click(await screen.findByRole("option", { name: "1 hour" }));
  await user.click(within(dialog).getByRole("combobox", { name: "Device keeps access" }));
  await user.click(await screen.findByRole("option", { name: "7 days" }));
  await user.click(within(dialog).getByRole("button", { name: "Create link" }));
  expect(await within(dialog).findByText(/Expires in (1 h 0 min|59:\d\d)$/)).toBeTruthy();
  expect(within(dialog).getByText(/Kitchen iPad · View and act · for 7 days/)).toBeTruthy();

  app.daemon.access.completePairing("iPad (Safari)");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await within(dialog).findByText("Kitchen iPad paired")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  const devices = await screen.findByRole("region", { name: "Devices" });
  expect(await within(devices).findByText("Kitchen iPad")).toBeTruthy();
  expect(within(devices).getByText(/Expires in (7d|6d 23h)/)).toBeTruthy();
});

test("an unused link is listed without its code and can be cancelled", async () => {
  const app = harness({ clock: () => Date.now() });
  await app.open("/settings/remote");
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Device name" }), "Spare phone");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
  const code = (await within(dialog).findByLabelText(/^Pairing code \S+$/)).textContent ?? "";
  await userEvent.keyboard("{Escape}");

  const open = await screen.findByRole("region", { name: "Open pairing links" });
  expect(within(open).getByText("Spare phone")).toBeTruthy();
  expect(open.textContent).not.toContain(code);
  await userEvent.click(within(open).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(app.daemon.access.pendingPairings()).toEqual([]));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Open pairing links" })).toBeNull(),
  );
});

test("a link for another machine is made on that machine", async () => {
  const app = harness({
    clock: () => Date.now(),
    machines: [{ hostId: "build", name: "Build server" }],
  });
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await userEvent.click(within(dialog).getByRole("combobox", { name: "Pairs with" }));
  await userEvent.click(await screen.findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
  await within(dialog).findByRole("img", { name: "Pairing QR code" });
  expect(app.machines.get("build")?.access.pendingPairings()).toHaveLength(1);
  expect(app.daemon.access.pendingPairings()).toHaveLength(0);
}, 30_000);

test("pairing shows a one-time QR code, its code and a link that can be copied in place", async () => {
  const user = userEvent.setup();
  // Pairing codes expire on the daemon's clock; here it is the page's.
  await harness({ clock: () => Date.now() }).open("/settings/remote");
  await user.click(await screen.findByRole("button", { name: "Pair a device" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await user.click(within(dialog).getByRole("radio", { name: "View only" }));
  await user.click(within(dialog).getByRole("button", { name: "Create link" }));

  expect(await within(dialog).findByRole("img", { name: "Pairing QR code" })).toBeTruthy();
  expect(within(dialog).getByText(/Expires in (5:00|4:5\d)$/)).toBeTruthy();
  expect(within(dialog).getByLabelText(/^Pairing code \S+$/)).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(await within(dialog).findByRole("button", { name: "Copied" })).toBeTruthy();
  const copied = await navigator.clipboard.readText();
  expect(new URLSearchParams(new URL(copied).hash.slice(1)).get("code")).toBeTruthy();
  expect(copied).toContain("scopes=read");
  expect(copied).not.toContain("operate");
});
