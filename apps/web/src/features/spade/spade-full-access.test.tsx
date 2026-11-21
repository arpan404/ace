import type { FakeSpadeApi } from "@ace/fake-daemon";
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

/** Scout's Security section on Details, and its "How it decides" choice. */
async function scoutsChoice() {
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Permissions" }));
  const section = (await profile.findByRole("heading", { name: "Security" })).closest("section");
  if (!section) throw new Error("no Security section");
  const security = within(section);
  return { security, picker: await security.findByRole("combobox", { name: "How it decides" }) };
}

async function choose(picker: HTMLElement, option: string) {
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a bot starts on Auto-review, and Full access asks first, then says what still asks and shows in its conversation", async () => {
  const { spade } = await spadeApp("/spade", seed);
  const { security, picker } = await scoutsChoice();
  expect(picker.textContent).toContain("Auto-review");

  // Cancelling the confirmation changes nothing.
  await choose(picker, "Full access");
  let dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("heading").textContent).toBe("Turn on Full access for Scout?");
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(spade.sent("PUT", "/v1/agents/scout/security/autonomy")).toEqual([]);

  await choose(picker, "Full access");
  dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(/still asks before it pays, sends anything in your name/)).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Turn on Full access" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/security/autonomy")).toEqual([
      { autonomy: "full_access" },
    ]),
  );
  expect(spade.security.autonomy("scout")).toBe("full_access");
  await waitFor(() =>
    expect(security.getByRole("combobox", { name: "How it decides" }).textContent).toContain(
      "Full access",
    ),
  );
  expect(security.getByText(/never reads your secrets\.$/)).toBeTruthy();
  // The conversation's pill says so, quietly.
  expect(
    await screen.findByRole("button", { name: "Scout, Full access: open its profile" }),
  ).toBeTruthy();
});

test("once the person confirmed Full access for a bot, turning it back on doesn't ask again, and Auto-review never asks", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.security.bot("scout").full_access_confirmed = true;
  });
  const { picker } = await scoutsChoice();
  await choose(picker, "Full access");
  await waitFor(() => expect(spade.security.autonomy("scout")).toBe("full_access"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await choose(picker, "Auto-review");
  await waitFor(() => expect(spade.security.autonomy("scout")).toBe("auto_review"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(spade.sent("PUT", "/v1/agents/scout/security/autonomy")).toEqual([
    { autonomy: "full_access" },
    { autonomy: "auto_review" },
  ]);
});

test("Settings › Spade › Security sets how every bot without its own decides, after a confirmation", async () => {
  const { spade } = await spadeApp("/settings/spade/security", seed);
  const picker = await screen.findByRole("combobox", { name: "How they decide" });
  expect(picker.textContent).toContain("Auto-review");
  await choose(picker, "Full access");
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByRole("heading").textContent).toBe(
    "Turn on Full access for every bot that doesn't set its own?",
  );
  await userEvent.click(dialog.getByRole("button", { name: "Turn on Full access" }));
  await waitFor(() => expect(spade.security.botDefaults.autonomy).toBe("full_access"));
  expect(spade.security.autonomy("scout")).toBe("full_access");
});
