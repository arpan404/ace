import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

function seed(spade: FakeSpadeApi, state: "idle" | "working" = "idle") {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  return spade.addAgent({ id: "scout", name: "Scout", state });
}

const at = Date.UTC(2026, 10, 12, 9, 30);

/** One line of Scout's egress log, in Spade's JSON. */
const line = (fields: Record<string, unknown>) => ({
  bot: "scout",
  run: "r1",
  method: "CONNECT",
  port: 443,
  allowed: true,
  sent: 0,
  received: 0,
  ...fields,
});

/** Scout's profile, on Details, and one of its sections. */
async function sectionOf(label: string) {
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const profile = within(await screen.findByRole("region", { name: "Scout's profile" }));
  await userEvent.click(profile.getByRole("tab", { name: "Details" }));
  const section = (await profile.findByRole("heading", { name: label })).closest("section");
  if (!section) throw new Error(`no ${label} section`);
  return within(section);
}

test("Settings › Spade › Security says whether this machine seals commands off", async () => {
  await spadeApp("/settings/spade/security", (api) => seed(api));
  expect(await screen.findByText("Commands run sealed off on this Mac.")).toBeTruthy();
  const sites = await screen.findByRole("list", { name: "Sites listed by default" });
  expect(within(sites).getByText("github.com")).toBeTruthy();
});

test("a machine without a sandbox says Spade asks before commands run", async () => {
  await spadeApp("/settings/spade/security", (api) => {
    seed(api);
    api.security.sandbox = {
      platform: "windows",
      mechanism: "none",
      files: "none",
      network: "none",
      reason: "Windows has no sandbox yet",
    };
  });
  expect(
    await screen.findByText(
      "This computer can't seal commands off yet, so Spade asks before they run.",
    ),
  ).toBeTruthy();
});

test("turning a bot's command network off saves that rule and shows it", async () => {
  const { spade } = await spadeApp("/spade", (api) => seed(api));
  const network = await sectionOf("Network");
  const picker = await network.findByRole("combobox", { name: "Network for commands" });
  expect(picker.textContent).toContain("Listed sites");
  await userEvent.click(picker);
  await userEvent.click(await screen.findByRole("option", { name: "Off" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/security/network")).toEqual([
      { mode: "off", allow: [], dropped: [] },
    ]),
  );
  await waitFor(() =>
    expect(network.getByRole("combobox", { name: "Network for commands" }).textContent).toContain(
      "Off",
    ),
  );
  expect(network.queryByText("Commands: listed sites")).toBeNull();
  expect(spade.security.bot("scout").network.mode).toBe("off");
});

test("a site Spade refuses says why and isn't added", async () => {
  const { spade } = await spadeApp("/spade", (api) => seed(api));
  const network = await sectionOf("Network");
  await userEvent.click(await network.findByText("Commands: listed sites"));
  await userEvent.type(network.getByRole("textbox", { name: "Add a site" }), "https://x/y{Enter}");
  expect((await network.findByRole("alert")).textContent).toContain("is not a host");
  expect(spade.security.bot("scout").network.allow).toEqual([]);
});

test("a restore refused while the bot works says so in one line", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api, "working");
    api.security.checkpoints.set("scout", [{ id: "cp1", at, reason: "auto" }]);
  });
  const checkpoints = await sectionOf("Checkpoints");
  const restore = await checkpoints.findByRole("button", { name: /^Restore / });
  expect(restore.getAttribute("aria-label")).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
  await userEvent.click(restore);
  const dialog = within(await screen.findByRole("dialog"));
  await userEvent.click(dialog.getByRole("button", { name: "Restore" }));
  expect((await checkpoints.findByRole("alert")).textContent).toBe(
    "Scout is working. Stop it first.",
  );
  expect(spade.sent("POST", "/v1/agents/scout/checkpoints/cp1/restore")).toHaveLength(1);
  expect(spade.security.checkpoints.get("scout")).toHaveLength(1);
});

test("network activity lists each connection once, newest first, with its bytes", async () => {
  await spadeApp("/spade", (api) => {
    seed(api);
    api.security.egress.set("scout", [
      line({ at, connection: 1, phase: "opened", host: "registry.npmjs.org" }),
      line({
        at: at + 5_000,
        connection: 1,
        phase: "closed",
        host: "registry.npmjs.org",
        sent: 3_000,
        received: 1_200_000,
      }),
      line({
        at: at + 60_000,
        connection: 2,
        phase: "refused",
        host: "tracker.example",
        allowed: false,
        reason: "tracker.example isn't listed",
      }),
    ]);
  });
  const activity = await sectionOf("Network activity");
  const rows = await activity.findAllByText(/^(registry\.npmjs\.org|tracker\.example)$/);
  expect(rows.map((row) => row.textContent)).toEqual(["tracker.example", "registry.npmjs.org"]);
  expect(activity.getByText("1.2 MB received · 3 KB sent")).toBeTruthy();
  expect(activity.getByText("tracker.example isn't listed")).toBeTruthy();
});
