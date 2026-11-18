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
  expect(spade.security.bot("scout").network?.mode).toBe("off");
});

test("a site Spade refuses says why and isn't added", async () => {
  const { spade } = await spadeApp("/spade", (api) => seed(api));
  const network = await sectionOf("Network");
  await userEvent.click(await network.findByText("Commands: listed sites"));
  await userEvent.type(network.getByRole("textbox", { name: "Add a site" }), "https://x/y{Enter}");
  expect((await network.findByRole("alert")).textContent).toContain("is not a host");
  expect(spade.security.bot("scout").network).toBeNull();
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

async function pick(box: HTMLElement, option: string) {
  await userEvent.click(box);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("Settings › Spade › Security saves where commands run, and says what outside means", async () => {
  const { spade } = await spadeApp("/settings/spade/security", (api) => seed(api));
  const commands = await screen.findByRole("combobox", { name: "Where commands run" });
  expect(commands.textContent).toContain("Sandboxed");
  expect(screen.queryByText(/can reach your files and sign-ins/)).toBeNull();
  await pick(commands, "Outside the sandbox");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/security/commands")).toEqual([{ commands: "outside" }]),
  );
  expect(
    await screen.findByText(
      "Commands outside the sandbox can reach your files and sign-ins, so each one is reviewed.",
    ),
  ).toBeTruthy();
  expect(spade.security.botDefaults.commands).toBe("outside");
});

test("the machine's network rules save for commands and for plugins, and a bad site says why", async () => {
  const { spade } = await spadeApp("/settings/spade/security", (api) => seed(api));
  await pick(await screen.findByRole("combobox", { name: "Network for plugins" }), "Off");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/security/plugin-network")).toEqual([
      { mode: "off", allow: [], dropped: [] },
    ]),
  );
  await userEvent.click(await screen.findByText("Commands: listed sites"));
  await userEvent.type(screen.getByRole("textbox", { name: "Add a site" }), "https://x/y{Enter}");
  expect((await screen.findByRole("alert")).textContent).toContain("is not a host");
  expect(spade.security.botDefaults.network.allow).toEqual([]);
});

test("a bot inherits the machine's commands, picks its own, and goes back", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.security.botDefaults.commands = "outside";
  });
  const commands = await sectionOf("Commands");
  const box = await commands.findByRole("combobox", { name: "Where commands run" });
  expect(box.textContent).toContain("Same as this Mac");
  await pick(box, "Sandboxed");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/security/commands")).toEqual([
      { commands: "sandboxed" },
    ]),
  );
  await pick(commands.getByRole("combobox", { name: "Where commands run" }), "Same as this Mac");
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/scout/security/commands").at(-1)).toEqual({
      commands: null,
    }),
  );
  expect(spade.security.bot("scout").commands).toBeNull();
});

test("a bot's own network rule says so and goes back to the machine's", async () => {
  const { spade } = await spadeApp("/spade", (api) => {
    seed(api);
    api.security.botDefaults.network = { mode: "open", allow: [], dropped: [] };
  });
  const network = await sectionOf("Network");
  expect(
    (await network.findByRole("combobox", { name: "Network for commands" })).textContent,
  ).toContain("Open");
  expect(network.getAllByText("Same as this Mac").length).toBeGreaterThan(0);
  await pick(network.getByRole("combobox", { name: "Network for commands" }), "Off");
  await userEvent.click(
    await network.findByRole("button", { name: "Use this Mac's network for commands" }),
  );
  await waitFor(() =>
    expect(spade.sent("DELETE", "/v1/agents/scout/security/network")).toHaveLength(1),
  );
  await waitFor(() =>
    expect(network.getByRole("combobox", { name: "Network for commands" }).textContent).toContain(
      "Open",
    ),
  );
  expect(spade.security.bot("scout").network).toBeNull();
});

/** Scout asks about a call for the reason Spade gives; its card, and what each button sends. */
const asks = [
  {
    ask: "outside_sandbox" as const,
    name: "shell",
    args: { command: "brew install jq" },
    app: undefined,
    title: "Run this outside the sandbox?",
    buttons: ["Allow once", "Always for this bot", "Deny"],
    sends: [
      ["Allow once", { allowed: true, always: false }],
      ["Always for this bot", { allowed: true, always: true }],
      ["Deny", { allowed: false, always: false }],
    ],
  },
  {
    ask: "undeclared" as const,
    name: "call_tool",
    args: { tool: "sync_inbox" },
    app: undefined,
    title: "Scout wants to use sync inbox",
    buttons: ["Allow", "Deny"],
    sends: [
      ["Allow", { allowed: true, always: true }],
      ["Deny", { allowed: false, always: false }],
    ],
  },
  {
    // A step in an app Spade may allow for the bot: its always is that app, never the tool.
    ask: "drive" as const,
    name: "screen_act",
    args: { app: "TextEdit", actions: [{ type: "click", id: 3 }] },
    app: "TextEdit",
    title: undefined,
    buttons: ["Allow TextEdit for this bot", "Deny", "Allow"],
    sends: [
      ["Allow", { allowed: true, always: false }],
      ["Allow TextEdit for this bot", { allowed: true, always: true }],
      ["Deny", { allowed: false, always: false }],
    ],
  },
  {
    // A step in Mail: allowed once or denied, nothing more.
    ask: "drive" as const,
    name: "screen_act",
    args: { app: "Mail", actions: [{ type: "type", text: "hi" }] },
    app: undefined,
    title: undefined,
    buttons: ["Deny", "Allow"],
    sends: [
      ["Allow", { allowed: true, always: false }],
      ["Deny", { allowed: false, always: false }],
    ],
  },
] as const;

for (const { ask, name, args, app, title, buttons, sends } of asks) {
  for (const [button, body] of sends) {
    test(`a request asked as ${ask}${app ? ` for ${app}` : ""}: ${button} sends ${JSON.stringify(body)}`, async () => {
      const { spade } = await spadeApp("/spade", (api) => {
        const scout = seed(api);
        api.askAbout(scout, "k1", name, args, ask, app);
      });
      await userEvent.click(await botRow("Scout"));
      const card = within(
        title
          ? await screen.findByRole("group", { name: title.replace(/[.?]$/, "") })
          : await screen.findByRole("group", { name: /^Scout wants to/ }),
      );
      expect(
        card.getAllByRole("button").map((each) => each.textContent?.replace(/Enter$/, "")),
      ).toEqual(expect.arrayContaining([...buttons]));
      expect(card.getAllByRole("button")).toHaveLength(buttons.length);
      if (ask === "outside_sandbox")
        expect(card.getByLabelText("Command").textContent).toBe("brew install jq");
      await userEvent.click(card.getByRole("button", { name: new RegExp(`^${button}(Enter)?$`) }));
      await waitFor(() =>
        expect(spade.sent("POST", "/v1/conversations/c-scout/approvals/k1")).toHaveLength(1),
      );
      const sent = spade.sent("POST", "/v1/conversations/c-scout/approvals/k1")[0] as Record<
        string,
        unknown
      >;
      expect(sent.allowed).toBe(body.allowed);
      expect(sent.always === true).toBe(body.always);
    });
  }
}
