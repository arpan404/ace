import { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "scout", name: "Scout" });
}

/** Scout's profile, on its Permissions tab. */
async function scoutsPermissions() {
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Permissions" }));
  await profile.findByRole("switch", { name: "Computer use" });
  return profile;
}

const checked = (element: HTMLElement) => element.getAttribute("aria-checked") === "true";

test("a bot's Permissions tab turns Computer use on for it, and Use default goes back to the default", async () => {
  const { spade } = await spadeApp("/spade", seed);
  const profile = await scoutsPermissions();
  // Driving is off until the person turns it on; sends and payments keep asking, so they're on.
  for (const name of ["Computer use", "Browser", "Simulators and devices"])
    expect(checked(profile.getByRole("switch", { name })), name).toBe(false);
  for (const name of ["Apps", "Send as you", "Payments"])
    expect(checked(profile.getByRole("switch", { name })), name).toBe(true);
  expect(profile.getAllByText(/every step runs without asking/)).toHaveLength(3);

  await userEvent.click(profile.getByRole("switch", { name: "Computer use" }));
  await waitFor(() => expect(spade.security.permissions.on("scout", "computer_use")).toBe(true));
  expect(spade.sent("PUT", "/v1/agents/scout/security/permissions")).toEqual([
    { key: "computer_use", on: true },
  ]);
  await waitFor(() =>
    expect(checked(profile.getByRole("switch", { name: "Computer use" }))).toBe(true),
  );
  expect(profile.getByText(/never uses the apps listed under Computer use/)).toBeTruthy();
  // Its own value offers the way back to the default, which is off.
  await userEvent.click(profile.getByRole("button", { name: "Use default" }));
  await waitFor(() =>
    expect(checked(profile.getByRole("switch", { name: "Computer use" }))).toBe(false),
  );
  expect(spade.sent("PUT", "/v1/agents/scout/security/permissions").at(-1)).toEqual({
    key: "computer_use",
    on: null,
  });
  expect(profile.queryByRole("button", { name: "Use default" })).toBeNull();
});

test("without the person's standing, turning a switch on asks them to confirm it's them and leaves it off", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.security.permissions.standing = false;
  });
  const profile = await scoutsPermissions();
  await userEvent.click(profile.getByRole("switch", { name: "Computer use" }));
  // The row asks them to confirm it's them (ace-account's flow, as for Full access).
  await waitFor(() =>
    expect(profile.getByText(/confirm it's you/i, { selector: "[role=status]" })).toBeTruthy(),
  );
  expect(checked(profile.getByRole("switch", { name: "Computer use" }))).toBe(false);
  expect(spade.security.permissions.on("scout", "computer_use")).toBe(false);
  // Turning one off needs no one's say.
  await userEvent.click(profile.getByRole("switch", { name: "Payments" }));
  await waitFor(() => expect(spade.security.permissions.on("scout", "pay")).toBe(false));
});

test("Settings › Spade sets the default switches and the apps bots never use", async () => {
  const { spade } = await spadeApp("/settings/spade/security", seed);
  const section = within(
    (await screen.findByRole("heading", { name: "Permissions" })).closest("section") ??
      document.body,
  );
  await userEvent.click(await section.findByRole("switch", { name: "Browser" }));
  await waitFor(() => expect(spade.security.permissions.defaults.browser).toBe(true));
  // A bot that sets none of its own follows it.
  expect(spade.security.permissions.on("scout", "browser")).toBe(true);

  await userEvent.click(section.getByText(/Never let bots use · 14 apps/));
  const list = within(section.getByRole("list", { name: "Apps bots never use" }));
  expect(list.getByText("1Password")).toBeTruthy();
  await userEvent.click(list.getByRole("button", { name: "Remove 1Password" }));
  await waitFor(() => expect(spade.security.permissions.neverApps).not.toContain("1Password"));
  await userEvent.type(section.getByRole("textbox", { name: "App to never use" }), "Mail");
  await userEvent.click(section.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(spade.security.permissions.neverApps).toContain("Mail"));
  expect(await list.findByText("Mail")).toBeTruthy();
});
