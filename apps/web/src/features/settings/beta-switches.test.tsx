import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, test } from "vitest";
import type { FakeDaemon } from "@ace/fake-daemon";
import { spadeInThisRelease } from "@ace/settings/beta";
import { harness } from "@/test/harness.tsx";
import { openNew, spadeApp } from "@/test/spade.ts";

const rail = () => screen.getByRole("navigation", { name: "App" });
const marketplaceOff = (daemon: FakeDaemon) =>
  daemon.services.settings.write("beta.marketplace", false);

test("the Marketplace switch on Settings › Beta saves the setting and hides or shows its rail place", async () => {
  const app = harness();
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name: "Marketplace" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(within(rail()).getByRole("button", { name: "Marketplace" })).toBeTruthy();

  await userEvent.click(toggle);

  await waitFor(() => expect(app.daemon.services.settings.get("beta.marketplace")).toBe(false));
  await waitFor(() =>
    expect(within(rail()).queryByRole("button", { name: "Marketplace" })).toBeNull(),
  );

  await userEvent.click(toggle);

  await waitFor(() => expect(app.daemon.services.settings.get("beta.marketplace")).toBe(true));
  expect(await within(rail()).findByRole("button", { name: "Marketplace" })).toBeTruthy();
});

test("Ask me before agents publish starts off and saves the person's choice", async () => {
  const app = harness();
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name: "Ask me before agents publish" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

  await userEvent.click(toggle);

  await waitFor(() =>
    expect(app.daemon.services.settings.get("market.askBeforeAgentPublish")).toBe(true),
  );
});

test.skipIf(!spadeInThisRelease)(
  "the Spade switch on Settings › Beta saves the setting and swaps Spade's place for its coming-soon mark",
  async () => {
    const app = harness();
    await app.open("/settings/beta");
    const toggle = await screen.findByRole("switch", { name: "Spade" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(await within(rail()).findByRole("link", { name: "Spade" })).toBeTruthy();

    await userEvent.click(toggle);

    await waitFor(() => expect(app.daemon.services.settings.get("beta.spade")).toBe(false));
    expect(await within(rail()).findByRole("button", { name: "Spade, coming soon" })).toBeTruthy();
    expect(within(rail()).queryByRole("link", { name: "Spade" })).toBeNull();

    await userEvent.click(toggle);

    await waitFor(() => expect(app.daemon.services.settings.get("beta.spade")).toBe(true));
    expect(await within(rail()).findByRole("link", { name: "Spade" })).toBeTruthy();
  },
);

test.skipIf(spadeInThisRelease)(
  "Settings › Beta has no Spade switch in a release that keeps Spade off",
  async () => {
    const app = harness();
    await app.open("/settings/beta");
    expect(await screen.findByRole("switch", { name: "Marketplace" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Spade" })).toBeNull();
  },
);

test("a marketplace address opens the modal only while the marketplace is on", async () => {
  for (const turnedOn of [true, false]) {
    const history = createMemoryHistory({ initialEntries: ["/chats?market=installed"] });
    const app = harness({ history });
    if (!turnedOn) marketplaceOff(app.daemon);
    const view = await app.open("/chats?market=installed");
    await screen.findByRole("navigation", { name: "App" });
    if (turnedOn) expect(await screen.findByRole("dialog", { name: "Marketplace" })).toBeTruthy();
    else {
      // Its setting has been read: the rail has no Marketplace, and no modal opened.
      await waitFor(() => expect(app.daemon.services.settings.get("beta.marketplace")).toBe(false));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(screen.queryByRole("dialog", { name: "Marketplace" })).toBeNull();
    }
    view.unmount();
  }
});

test("Appearance offers More Suits only while the marketplace is on", async () => {
  const on = harness();
  const shown = await on.open("/settings/appearance");
  expect(await screen.findByRole("button", { name: "More Suits" })).toBeTruthy();
  shown.unmount();

  const off = harness();
  marketplaceOff(off.daemon);
  await off.open("/settings/appearance");
  expect(await screen.findByRole("link", { name: "Make your own" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More Suits" })).toBeNull();
});

test("the Skills Add menu offers the marketplace only while it is on", async () => {
  for (const turnedOn of [true, false]) {
    const app = harness();
    if (!turnedOn) marketplaceOff(app.daemon);
    const view = await app.open("/skills");
    await userEvent.click(await screen.findByRole("button", { name: "Add a skill" }));
    expect(await screen.findByRole("menuitem", { name: /Install a plugin/ })).toBeTruthy();
    const item = screen.queryByRole("menuitem", { name: "From the marketplace" });
    expect(item !== null).toBe(turnedOn);
    view.unmount();
  }
});

const appsButton = async () => {
  const search = await screen.findByRole("button", { name: "Search conversations" });
  const head = search.parentElement;
  if (!head) throw new Error("Spade's list head is missing");
  return within(head).queryByRole("button", { name: "Apps, plugins and skills" });
};

test("Spade's apps button leads to the marketplace while it is on", async () => {
  await spadeApp("/spade", () => {});
  expect(await appsButton()).not.toBeNull();
});

test("Spade has no apps button while the marketplace is off", async () => {
  await spadeApp("/spade", () => {}, { daemon: marketplaceOff });
  expect(await appsButton()).toBeNull();
});

test("New bot offers bots from the marketplace only while it is on", async () => {
  for (const turnedOn of [true, false]) {
    await spadeApp(
      "/spade",
      (spade) => {
        spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
        spade.teams.templates.push({
          id: "digest",
          name: "Morning digest",
          blurb: "Your feeds, summed up.",
          task: "Summarise my feeds.",
          face: { kind: "character", v: 1, body: "bird", pair: "sky", marking: "cap" },
          model_kind: "fast",
          routines: [],
        });
      },
      turnedOn ? {} : { daemon: marketplaceOff },
    );
    await openNew("New bot");
    // The templates' list, which ends with the way to the marketplace.
    expect(await screen.findByRole("button", { name: /^Morning digest/ })).toBeTruthy();
    const link = screen.queryByRole("button", { name: "From the marketplace" });
    expect(link !== null).toBe(turnedOn);
    cleanup();
  }
});

/** The palette's Go to command (Settings › Beta's row also matches the word). */
const option = () =>
  screen.queryAllByRole("option").find((each) => each.textContent === "MarketplaceGo to");

test("the command palette goes to the Marketplace only while it is on", async () => {
  for (const turnedOn of [true, false]) {
    const app = harness();
    if (!turnedOn) marketplaceOff(app.daemon);
    const view = await app.open("/chats");
    await screen.findByRole("navigation", { name: "App" });
    if (turnedOn) await within(rail()).findByRole("button", { name: "Marketplace" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole(
      "combobox",
      { name: "Search commands" },
      { timeout: 10000 },
    );
    await userEvent.type(search, "Marketplace");
    if (turnedOn) {
      await waitFor(() => expect(option()).toBeDefined());
      const command = option();
      if (command) await userEvent.click(command);
      expect(await screen.findByRole("dialog", { name: "Marketplace" })).toBeTruthy();
    } else {
      // Settings › Beta has been read (Appearance's own link waits on it the same way).
      await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
      expect(option()).toBeUndefined();
    }
    view.unmount();
  }
});
