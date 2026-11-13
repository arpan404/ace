import { screen, waitFor } from "@testing-library/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const hidden = { state: "off" as const, hidden: true, reason: "Spade is hidden on this machine." };

test("the rail shows Spade's place or its coming-soon mark as the daemon says, and follows a change live", async () => {
  const app = harness();
  app.daemon.spade.status = hidden;
  await app.open("/new");
  expect(await screen.findByRole("img", { name: "Spade, coming soon" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Spade" })).toBeNull();

  app.daemon.spade.setStatus({ state: "off" });
  expect(await screen.findByRole("link", { name: "Spade" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Spade, coming soon" })).toBeNull();

  app.daemon.spade.setStatus(hidden);
  expect(await screen.findByRole("img", { name: "Spade, coming soon" })).toBeTruthy();
});

test("opening Spade or its settings while the daemon hides it leads away from them", async () => {
  for (const [path, away] of [
    ["/spade", "/"],
    ["/settings/spade", "/settings"],
  ] as const) {
    const history = createMemoryHistory({ initialEntries: [path] });
    const app = harness({ history });
    app.daemon.spade.status = hidden;
    const view = await app.open(path);
    await waitFor(() => expect(history.location.pathname).not.toBe(path));
    expect(history.location.pathname.startsWith(away)).toBe(true);
    view.unmount();
  }
});
