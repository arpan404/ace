import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("machines and paired devices are listed; revoking a device removes it after confirming", async () => {
  const app = harness({ machines: [{ hostId: "build-box", name: "Build server" }] });
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  expect(await within(machines).findByText("This Mac")).toBeTruthy();
  expect(await within(machines).findByText("Build server")).toBeTruthy();

  const devices = screen.getByRole("region", { name: "Paired devices" });
  expect(await within(devices).findByText("iPhone 16 Pro")).toBeTruthy();
  await userEvent.click(within(devices).getByRole("button", { name: "Revoke iPhone 16 Pro" }));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(within(devices).getByText("iPhone 16 Pro")).toBeTruthy();

  await userEvent.click(within(devices).getByRole("button", { name: "Revoke iPhone 16 Pro" }));
  const dialog = await screen.findByRole("dialog", { name: "Revoke iPhone 16 Pro?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(within(devices).queryByText("iPhone 16 Pro")).toBeNull());
  expect(within(devices).getByText("iPad Air")).toBeTruthy();
  expect(await screen.findByText("iPhone 16 Pro can no longer reach this computer")).toBeTruthy();
  expect(app.daemon.access.list().map((device) => device.name)).toEqual(["iPad Air"]);
});

test("pairing shows a one-time QR code, its code and a link that can be copied", async () => {
  const user = userEvent.setup();
  // Pairing codes expire on the daemon's clock; here it is the page's.
  await harness({ clock: () => Date.now() }).open("/settings/remote");
  await user.click(await screen.findByRole("button", { name: "Pair" }));
  const dialog = await screen.findByRole("dialog", { name: "Pair a device" });
  await user.click(within(dialog).getByRole("button", { name: "View only" }));
  await user.click(within(dialog).getByRole("button", { name: "Show pairing code" }));

  expect(await within(dialog).findByRole("img", { name: "Pairing QR code" })).toBeTruthy();
  expect(within(dialog).getByText(/^Expires in (5:00|4:5\d)$/)).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  const copied = await navigator.clipboard.readText();
  expect(new URLSearchParams(new URL(copied).hash.slice(1)).get("code")).toBeTruthy();
  expect(copied).toContain("scopes=read");
  expect(copied).not.toContain("operate");
});

test("an offline machine explains the failure, reconnects, and can be forgotten", async () => {
  const app = harness({ machines: [{ hostId: "build-box", name: "Build server" }] });
  await app.open("/settings/remote");
  const region = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(app.pool().machine("build-box")?.status).toBe("online"));
  app.crashMachine("build-box");
  await waitFor(() =>
    expect(
      within(region)
        .getByRole("button", { name: "Reconnect Build server" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(within(region).getByText("Offline")).toBeTruthy();
  await userEvent.hover(within(region).getByText("Build server"));
  expect(await screen.findByText(/Couldn't reach this machine/)).toBeTruthy();
  await userEvent.click(within(region).getByRole("button", { name: "Reconnect Build server" }));
  await waitFor(() => expect(app.pool().machine("build-box")?.status).toBe("online"));
  await userEvent.click(within(region).getByRole("button", { name: "Forget Build server" }));
  await waitFor(() => expect(within(region).queryByText("Build server")).toBeNull());
  expect(await screen.findByText("Build server forgotten")).toBeTruthy();
});
