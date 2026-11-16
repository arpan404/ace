import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, test } from "vitest";
import type { FakeDaemon } from "@ace/fake-daemon";
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
  expect(within(rail()).getByRole("link", { name: "Marketplace" })).toBeTruthy();

  await userEvent.click(toggle);

  await waitFor(() => expect(app.daemon.services.settings.get("beta.marketplace")).toBe(false));
  await waitFor(() =>
    expect(within(rail()).queryByRole("link", { name: "Marketplace" })).toBeNull(),
  );

  await userEvent.click(toggle);

  await waitFor(() => expect(app.daemon.services.settings.get("beta.marketplace")).toBe(true));
  expect(await within(rail()).findByRole("link", { name: "Marketplace" })).toBeTruthy();
});

test("the Spade switch on Settings › Beta saves the setting and swaps Spade's place for its coming-soon mark", async () => {
  const app = harness();
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name: "Spade" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(await within(rail()).findByRole("link", { name: "Spade" })).toBeTruthy();

  await userEvent.click(toggle);

  await waitFor(() => expect(app.daemon.services.settings.get("beta.spade")).toBe(false));
  expect(await within(rail()).findByRole("img", { name: "Spade, coming soon" })).toBeTruthy();
  expect(within(rail()).queryByRole("link", { name: "Spade" })).toBeNull();

  await userEvent.click(toggle);

  await waitFor(() => expect(app.daemon.services.settings.get("beta.spade")).toBe(true));
  expect(await within(rail()).findByRole("link", { name: "Spade" })).toBeTruthy();
});

test("a marketplace address opened while it is turned off leads home", async () => {
  const history = createMemoryHistory({ initialEntries: ["/marketplace/installed"] });
  const app = harness({ history });
  marketplaceOff(app.daemon);
  await app.open("/marketplace/installed");
  await waitFor(() => expect(history.location.pathname).toBe("/"));
});

test("Appearance offers More Suits only while the marketplace is on", async () => {
  const on = harness();
  const shown = await on.open("/settings/appearance");
  expect(await screen.findByRole("link", { name: "More Suits" })).toBeTruthy();
  shown.unmount();

  const off = harness();
  marketplaceOff(off.daemon);
  await off.open("/settings/appearance");
  expect(await screen.findByRole("link", { name: "Make your own" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "More Suits" })).toBeNull();
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
  return within(head).queryByRole("link", { name: "Apps, plugins and skills" });
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
    const link = screen.queryByRole("link", { name: "From the marketplace" });
    expect(link !== null).toBe(turnedOn);
    cleanup();
  }
});
