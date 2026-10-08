import type { ProviderKind, InstallMethod } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
function missing(provider: ProviderKind, method: InstallMethod = "npm") {
  const app = harness({ onboarding: "pending" });
  app.daemon.services.installed.delete(provider);
  app.daemon.services.providerInstalls.autoComplete = false;
  app.daemon.services.providerInstalls.methods[provider] = method;
  const row = app.daemon.services.providerStatuses.find((entry) => entry.provider === provider);
  if (!row) throw new Error("Provider fixture unavailable");
  Object.assign(row, { installed: false, auth: "logged_out" });
  for (const account of app.daemon.services.accounts.filter(
    (entry) => entry.provider === provider,
  )) {
    account.quota.auth = "logged_out";
    account.availability = "logged_out";
  }
  app.daemon.services.models = app.daemon.services.models.filter(
    (model) => model.provider !== provider,
  );
  return app;
}
const codexRow = () => screen.getByRole("group", { name: "Codex" });
const providers = [
  ["codex", "Codex", "npm"],
  ["claude", "Claude Code", "brew"],
  ["opencode", "OpenCode", "script"],
  ["antigravity", "Antigravity", "registry"],
  ["pi", "Pi", "npm"],
] as const;

test.each(providers)(
  "%s installs and signs in without leaving Setup",
  async (provider, name, method) => {
    const app = missing(provider, method);
    await app.open("/setup");
    await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
    const item = () => screen.getByRole("listitem", { name });
    await userEvent.click(
      await within(await screen.findByRole("listitem", { name })).findByRole("button", {
        name: "Install",
      }),
    );
    await within(item()).findByRole("progressbar", { name: `${name} installation progress` });
    app.daemon.services.providerInstalls.complete("fake-install-1");
    await userEvent.click(await screen.findByRole("button", { name: `Sign in to ${name}` }));
    const dialog = await screen.findByRole("dialog", { name: `Sign in to ${name}` });
    if (provider === "opencode" || provider === "pi") {
      await userEvent.click(await within(dialog).findByRole("button", { name: "GitHub Copilot" }));
      await userEvent.click(await within(dialog).findByRole("button", { name: "Continue" }));
    }
    if (provider === "codex" || provider === "opencode" || provider === "pi")
      await within(dialog).findByLabelText("Sign-in code");
    else await within(dialog).findByRole("link", { name: "Open sign-in page" });
    app.daemon.services.providerLogin.complete("fake-login-1");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(within(item()).queryByRole("button", { name: `Sign in to ${name}` })).toBeNull(),
    );
    expect(within(item()).getByText("Ready")).toBeTruthy();
  },
  30_000,
);

test("Settings installs on the list, a failed attempt offers Retry and Details, and cancellation keeps Install available", async () => {
  const app = missing("codex");
  app.daemon.services.providerInstalls.scenarios.codex = "failure";
  await app.open("/settings/providers");
  const item = codexRow;
  await userEvent.click(
    await within(await screen.findByRole("group", { name: "Codex" })).findByRole("button", {
      name: "Install",
    }),
  );
  await within(item()).findByRole("progressbar");
  app.daemon.services.providerInstalls.complete("fake-install-1");
  await within(item()).findByRole("button", { name: "Retry" });
  await userEvent.click(within(item()).getByRole("button", { name: "Codex installation details" }));
  expect(within(item()).getByLabelText("Codex redacted installation log").textContent).toContain(
    "Downloading official package",
  );
  app.daemon.services.providerInstalls.scenarios.codex = "success";
  await userEvent.click(within(item()).getByRole("button", { name: "Retry" }));
  await userEvent.click(
    await within(item()).findByRole("button", { name: "Cancel Codex installation" }),
  );
  await within(item()).findByRole("button", { name: "Install" });
  await userEvent.click(within(item()).getByRole("button", { name: "Install" }));
  app.daemon.services.providerInstalls.complete("fake-install-3");
  expect(await screen.findByRole("button", { name: "Sign in to Codex" })).toBeTruthy();
}, 30_000);

test("a missing prerequisite opens its official download and retry continues with installation", async () => {
  const app = missing("pi");
  app.daemon.services.providerInstalls.scenarios.pi = "missing_prerequisite";
  await app.open("/settings/providers/pi");
  const row = await screen.findByRole("region", { name: "Setup" });
  await userEvent.click(await within(row).findByRole("button", { name: "Install" }));
  expect((await within(row).findByRole("link", { name: "Get Node.js" })).getAttribute("href")).toBe(
    "https://nodejs.org/en/download",
  );
  expect(within(row).getByText(/It includes npm/)).toBeTruthy();
  app.daemon.services.providerInstalls.scenarios.pi = "success";
  await userEvent.click(
    within(row).getByRole("button", {
      name: "Retry Pi installation after installing prerequisites",
    }),
  );
  await within(row).findByRole("progressbar");
  app.daemon.services.providerInstalls.complete("fake-install-1");
  expect(await within(row).findByRole("button", { name: "Sign in to Pi" })).toBeTruthy();
}, 30_000);

test("a download-only distribution explains the platform limit and opens the official site", async () => {
  const app = missing("antigravity", "registry");
  app.daemon.services.providerInstalls.scenarios.antigravity = "download_only";
  await app.open("/setup");
  await userEvent.click(await screen.findByRole("button", { name: "Get started" }));
  const row = await screen.findByRole("listitem", { name: "Antigravity" });
  await userEvent.click(await within(row).findByRole("button", { name: "Install" }));
  expect(
    (await within(row).findByRole("link", { name: "Get Antigravity" })).getAttribute("href"),
  ).toBe("https://antigravity.google/download");
  expect(within(row).getByText(/no installable distribution/)).toBeTruthy();
  expect(within(row).queryByRole("button", { name: "Install" })).toBeNull();
  app.daemon.services.installed.add("antigravity");
  Object.assign(
    app.daemon.services.providerStatuses.find((entry) => entry.provider === "antigravity") ?? {},
    { installed: true, auth: "logged_out" },
  );
  await userEvent.click(screen.getByRole("button", { name: "Check again" }));
  const installedRow = await screen.findByRole("listitem", { name: "Antigravity" });
  await userEvent.click(
    await within(installedRow).findByRole("button", { name: "Sign in to Antigravity" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Antigravity" });
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Done" }));
  expect(await within(installedRow).findByText("Ready")).toBeTruthy();
}, 30_000);

test("Cursor uses its bundled SDK and signs in without a CLI installer", async () => {
  const app = harness();
  await app.open("/settings/providers");
  const row = await screen.findByRole("group", { name: "Cursor" });
  expect(within(row).queryByRole("button", { name: "Install" })).toBeNull();
  await userEvent.click(await within(row).findByRole("button", { name: "Sign in to Cursor" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign in to Cursor" });
  await within(dialog).findByRole("link", { name: "Open sign-in page" });
  app.daemon.services.providerLogin.complete("fake-login-1");
  await userEvent.click(await within(dialog).findByRole("button", { name: "Done" }));
  expect(await within(row).findByText("Ready")).toBeTruthy();
});
