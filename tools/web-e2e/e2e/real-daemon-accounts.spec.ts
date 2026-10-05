import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  daemonPort,
  daemonTokenPath,
  pairedDeviceName,
  seededTitle,
} from "../src/real-daemon-config.ts";

/** Opens the app against the real e2e daemon (scripted providers, no CLI runs). */
async function connect(page: Page, path: string) {
  const token = readFileSync(daemonTokenPath, "utf8").trim();
  await page.goto(
    `${path}#token=${token}&daemon=${encodeURIComponent(`ws://127.0.0.1:${daemonPort}/`)}`,
  );
  await expect(
    page.getByRole("button", { name: "Account and connection", exact: true }),
  ).toBeAttached();
}

test("the run-out policy is stored by the daemon and read back after a reload", async ({
  page,
}) => {
  await connect(page, "/more/accounts");
  const policy = page.getByRole("radiogroup", { name: "When an account runs out" });
  const resume = policy.getByRole("radio", { name: /Resume when the window resets/ });
  const manual = policy.getByRole("radio", { name: /Stop and let me decide/ });

  await resume.click();
  await expect(resume).toHaveAttribute("aria-checked", "true");
  await page.reload();

  await expect(resume).toHaveAttribute("aria-checked", "true");
  await manual.click();
  await expect(manual).toHaveAttribute("aria-checked", "true");
});

test("the web app on another origin lists and revokes paired devices through the daemon access routes", async ({
  page,
}) => {
  await connect(page, "/settings/remote");
  const devices = page.getByRole("region", { name: "Paired devices" });

  // The app (127.0.0.1:5191) calls the daemon (127.0.0.1:4391) cross-origin; the daemon allows it.
  await expect(devices.getByText(pairedDeviceName)).toBeVisible();
  await devices.getByRole("button", { name: `Revoke ${pairedDeviceName}` }).click();
  const revoke = page.getByRole("dialog", { name: `Revoke ${pairedDeviceName}?` });
  await revoke.getByRole("button", { name: "Revoke" }).click();
  await expect(revoke).toBeHidden();
  await expect(
    devices.getByText("No phones or browsers are paired with this daemon."),
  ).toBeVisible();

  await devices.getByRole("button", { name: "Pair" }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a device" });
  await dialog.getByRole("button", { name: "Show pairing code" }).click();
  // The e2e daemon listens on loopback only, so it says how to turn remote access on.
  await expect(dialog.getByRole("alert")).toContainText("ACE_LISTEN=lan or ACE_LISTEN=tailscale");
});

test("the Devices tab opens its own authenticated channel to the daemon", async ({ page }) => {
  await connect(page, "/");
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: new RegExp(seededTitle) }).click();
  await expect(page.getByRole("heading", { level: 1, name: seededTitle })).toBeVisible();

  await page.getByRole("button", { name: "Right panel" }).click();
  const panel = page.getByRole("region", { name: "Thread panel" });
  // Tools beyond Changes and Agents open from the side panel's + (the new-tab launcher).
  await panel.getByRole("button", { name: "New tab" }).click();
  await panel
    .getByRole("list", { name: "Tools" })
    .getByRole("button", { name: /^Devices/ })
    .click();
  await expect(panel.getByRole("tab", { name: "Devices", selected: true })).toBeVisible();

  // Connected: the daemon answered the channel's hello; nothing on this machine is touched yet.
  await expect(panel.getByRole("button", { name: "Enable devices" })).toBeVisible();
});
