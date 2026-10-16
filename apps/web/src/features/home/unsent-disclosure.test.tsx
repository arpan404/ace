import { workbench } from "@ace/fake-daemon";
import { Organizer } from "@ace/ui-core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

/**
 * Adding Unsent work must not touch other disclosures (issue #848): closing Settled (and
 * Snoozed) sticks while a new draft is typed and while it is sent.
 */
async function openWorkbench() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  const nav = within(await screen.findByRole("navigation", { name: "Threads" }));
  await nav.findByRole("link", { name: /Partial refunds/ });
  return { app, nav };
}

test("typing a draft keeps Settled closed without touching disclosure state", async () => {
  const openSpy = vi.spyOn(Organizer.prototype, "setSettledOpen");
  const snoozeSpy = vi.spyOn(Organizer.prototype, "setSnoozedOpen");
  try {
    await openWorkbench();
    const nav = within(screen.getByRole("navigation", { name: "Threads" }));
    expect(await nav.findByRole("button", { name: /^Settled/ })).toMatchObject({
      getAttribute: expect.any(Function),
    });
    expect(
      (await nav.findByRole("button", { name: /^Settled/ })).getAttribute("aria-expanded"),
    ).toBe("false");
    openSpy.mockClear();
    snoozeSpy.mockClear();
    await userEvent.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "Unsent keeps place",
    );
    await screen.findByRole("link", { name: /Unsent keeps place.*Draft/ });
    expect(
      (await nav.findByRole("button", { name: /^Settled/ })).getAttribute("aria-expanded"),
    ).toBe("false");
    // The settled rows stay folded away too, not just the toggle.
    expect(nav.queryByRole("link", { name: /^Bump Codex/ })).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
    expect(snoozeSpy).not.toHaveBeenCalled();
  } finally {
    openSpy.mockRestore();
    snoozeSpy.mockRestore();
  }
});

test("sending a draft keeps Settled closed without touching disclosure state", async () => {
  const openSpy = vi.spyOn(Organizer.prototype, "setSettledOpen");
  const snoozeSpy = vi.spyOn(Organizer.prototype, "setSnoozedOpen");
  try {
    await openWorkbench();
    const nav = within(screen.getByRole("navigation", { name: "Threads" }));
    await userEvent.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "Send keeps place",
    );
    await screen.findByRole("link", { name: /Send keeps place.*Draft/ });
    openSpy.mockClear();
    snoozeSpy.mockClear();
    await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "{Enter}");
    await screen.findByRole("heading", { level: 1, name: "Send keeps place" });
    expect(
      (await nav.findByRole("button", { name: /^Settled/ })).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(nav.queryByRole("link", { name: /^Bump Codex/ })).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
    expect(snoozeSpy).not.toHaveBeenCalled();
  } finally {
    openSpy.mockRestore();
    snoozeSpy.mockRestore();
  }
});
