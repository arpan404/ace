import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import {
  readSettingsModels,
  readSettingsPage,
  writeSettingsPage,
  type PagePorts,
} from "./settings-page.ts";
import type { PageRow, SettingsPage } from "./settings-page-wire.ts";

/*
 * Native settings pages over the real SDK and an in-process fake daemon: the Agents page in the
 * web's words, every change checked against this machine before it is written, and the model
 * sheet for roles and the utility model listing the composer picker's rows.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-settings-page-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

function fixture(): FakeDaemon {
  return new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "ios-test-token" });
}
async function ports(daemon = fixture()): Promise<PagePorts & { daemon: FakeDaemon }> {
  return { owner: await connect(daemon), now: Date.now, preview: (text) => text, daemon };
}
async function page(p: PagePorts, id: string): Promise<SettingsPage> {
  const reply = await readSettingsPage(p, id);
  if (!("sections" in reply)) throw new Error(reply.message);
  return reply;
}
function row(shown: SettingsPage, id: string): PageRow {
  const found = shown.sections.flatMap((section) => section.rows).find((entry) => entry.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}
const labels = (entry: PageRow) =>
  entry.control.kind === "choice" ? entry.control.choices.map((choice) => choice.label) : [];

test("the Agents page names its sections and choices in the web's words", async () => {
  const p = await ports();
  const shown = await page(p, "agents");
  expect(shown.sections.map((section) => section.title)).toEqual([
    "New threads",
    "While agents work",
    "Roles",
    "Thread list",
    "Generation",
    "Automations",
  ]);
  const limit = row(shown, "threads.limitPolicy");
  expect(limit.title).toBe("When an account hits its limit");
  expect(labels(limit)).toEqual([
    "Stop and ask me",
    "Resume when it resets",
    "Snooze until it resets",
    "Move to another account",
  ]);
  expect(limit.note).toBe("At the limit it stops until you choose what to do.");
  expect(limit.source).toEqual({ kind: "defaults", label: "Default" });
  const children = row(shown, "agents.maxRunningChildren");
  expect(children.title).toBe("Agents a thread runs at once");
  expect(labels(children)).toEqual(["No limit", "1", "2", "4", "8", "16", "32"]);
  expect(children.value).toBe("null");
  expect(row(shown, "threads.followUpBehavior").title).toBe("Messages sent while the agent works");
  expect(row(shown, "roles.build").control).toMatchObject({
    kind: "link",
    page: "role.build",
    label: "Not set",
  });
});

test("a usage-limit choice is saved on the machine and the page says so", async () => {
  const p = await ports();
  const written = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "agents",
    row: "threads.limitPolicy",
    value: "resume_at_reset",
  });
  expect(written.ok).toBe(true);
  expect(p.daemon.services.settings.get("threads.limitPolicy")).toBe("resume_at_reset");
  const limit = row(written.page!, "threads.limitPolicy");
  expect(limit.value).toBe("resume_at_reset");
  expect(limit.note).toBe("At the limit it waits and resumes when the window resets.");
  expect(limit.source?.label).toBe("This machine");
});

test("the child limit saves a count and No limit saves none", async () => {
  const p = await ports();
  const write = (value: string) =>
    writeSettingsPage(p, {
      type: "settings.page.set",
      page: "agents",
      row: "agents.maxRunningChildren",
      value,
    });
  expect((await write("4")).ok).toBe(true);
  expect(p.daemon.services.settings.get("agents.maxRunningChildren")).toBe(4);
  const cleared = await write("null");
  expect(p.daemon.services.settings.get("agents.maxRunningChildren")).toBeNull();
  expect(row(cleared.page!, "agents.maxRunningChildren").note).toBe(
    "Agents a thread hands work to all start at once.",
  );
});

test("a choice the machine doesn't offer is refused in words and nothing is written", async () => {
  const p = await ports();
  const refused = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "agents",
    row: "threads.limitPolicy",
    value: "forever",
  });
  expect(refused).toMatchObject({
    ok: false,
    message: "That isn't a choice for When an account hits its limit.",
  });
  expect(p.daemon.services.settings.isSet("threads.limitPolicy")).toBe(false);
  const provider = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "agents",
    row: "providers.default",
    value: "not-a-provider",
  });
  expect(provider).toMatchObject({
    ok: false,
    message: "That provider isn't installed on this machine.",
  });
});

test("the default provider offers the installed CLIs and saves the one picked", async () => {
  const p = await ports();
  const before = row(await page(p, "agents"), "providers.default");
  expect(before.title).toBe("Default provider for new threads");
  expect(before.control.kind === "choice" && before.control.choices.length).toBeGreaterThan(0);
  const pick = before.control.kind === "choice" ? before.control.choices.at(-1)!.id : "";
  const written = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "agents",
    row: "providers.default",
    value: pick,
  });
  expect(written.ok).toBe(true);
  expect(p.daemon.services.settings.get("providers.default")).toBe(pick);
  expect(row(written.page!, "providers.default")).toMatchObject({
    value: pick,
    source: { label: "This machine" },
  });
});

test("a setting an environment variable overrides is shown locked and can't be changed", async () => {
  const p = await ports();
  const overridden: PagePorts = {
    ...p,
    owner: {
      request: (async (message: { type: string; key?: string }, options: unknown) => {
        const reply = await p.owner.request(message as never, options as never);
        if (message.type !== "settings.get" || message.key !== "threads.followUpBehavior")
          return reply;
        const entries = (reply as unknown as { entries: { provenance: string }[] }).entries;
        return {
          ...reply,
          entries: entries.map((entry) => Object.assign({}, entry, { provenance: "environment" })),
        };
      }) as PagePorts["owner"]["request"],
    },
  };
  const follow = row(await page(overridden, "agents"), "threads.followUpBehavior");
  expect(follow.source?.label).toBe("Environment override");
  expect(follow.locked).toMatch(/environment variable/);
  const refused = await writeSettingsPage(overridden, {
    type: "settings.page.set",
    page: "agents",
    row: "threads.followUpBehavior",
    value: "steer",
  });
  expect(refused.ok).toBe(false);
  expect(p.daemon.services.settings.isSet("threads.followUpBehavior")).toBe(false);
});

test("a role takes a model from the composer's picker, then its effort, and clears again", async () => {
  const p = await ports();
  const sheet = await readSettingsModels(p, {
    type: "settings.models",
    page: "role.review",
    row: "role.model",
  });
  const agent = sheet.providers.find(
    (entry) => entry.ready && entry.models.some((model) => model.efforts.length),
  );
  const model = agent?.models.find((entry) => entry.efforts.length);
  if (!agent || !model) throw new Error("fixture has no model with efforts");
  const picked = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "role.review",
    row: "role.model",
    value: { key: model.key, account: model.account },
  });
  expect(picked.ok).toBe(true);
  expect(p.daemon.services.settings.get("providers.reviewer.provider")).toBe(agent.provider);
  expect(row(picked.page!, "role.model").control).toMatchObject({
    kind: "model",
    label: model.label,
    cleared: false,
  });
  const effort = row(picked.page!, "role.effort");
  expect(labels(effort)).toEqual(["Default effort", ...model.efforts.map((entry) => entry.label)]);
  const high = model.efforts.at(-1)!.id;
  const tuned = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "role.review",
    row: "role.effort",
    value: high,
  });
  expect(tuned.ok).toBe(true);
  expect(p.daemon.services.settings.get("providers.reviewer.reasoningEffort")).toBe(high);
  const link = row(await page(p, "agents"), "roles.review");
  expect(link.control).toMatchObject({
    kind: "link",
    provider: agent.provider,
    label: `${model.label} · ${model.efforts.at(-1)!.label}`,
  });
  const cleared = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "role.review",
    row: "role.model",
    value: null,
  });
  expect(cleared.ok).toBe(true);
  expect(p.daemon.services.settings.get("providers.reviewer.provider")).toBeNull();
  expect(p.daemon.services.settings.get("providers.reviewer.reasoningEffort")).toBe("default");
  expect(cleared.page!.sections[0]!.rows.map((entry) => entry.id)).toEqual(["role.model"]);
});

test("a model another machine has but this one doesn't is refused", async () => {
  const p = await ports();
  const refused = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "role.build",
    row: "role.model",
    value: { key: "codex\u0000not-on-this-machine", account: "" },
  });
  expect(refused).toMatchObject({ ok: false, message: "That model isn't on this machine." });
  expect(p.daemon.services.settings.isSet("providers.coder.model")).toBe(false);
});

test("the utility model reads Auto until one is picked, then names it with its account", async () => {
  const p = await ports();
  const before = row(await page(p, "agents"), "generation.model");
  expect(before.title).toBe("Titles and commit messages");
  expect(before.control).toMatchObject({ kind: "model", cleared: true, clear: "Auto" });
  const sheet = await readSettingsModels(p, {
    type: "settings.models",
    page: "agents",
    row: "generation.model",
  });
  const model = sheet.providers.find((entry) => entry.ready)?.models[0];
  if (!model) throw new Error("fixture has no utility model");
  const written = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "agents",
    row: "generation.model",
    value: { key: model.key, account: model.account },
  });
  expect(written.ok).toBe(true);
  expect(p.daemon.services.settings.get("generation.model")).toMatchObject({
    model: expect.any(String),
  });
  expect(row(written.page!, "generation.model").control).toMatchObject({
    label: model.label,
    cleared: false,
  });
  const auto = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "agents",
    row: "generation.model",
    value: null,
  });
  expect(p.daemon.services.settings.get("generation.model")).toBeNull();
  expect(row(auto.page!, "generation.model").control).toMatchObject({ cleared: true });
});

test("the machine's other pages save numbers, lists and text, refusing what the setting won't take", async () => {
  const p = await ports();
  const days = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "storage",
    row: "storage.retentionDays",
    value: 14,
  });
  expect(days.ok).toBe(true);
  expect(p.daemon.services.settings.get("storage.retentionDays")).toBe(14);
  const apps = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "computer",
    row: "computer.blockedApps",
    value: [" Notes ", "", "com.apple.mail"],
  });
  expect(apps.ok).toBe(true);
  expect(p.daemon.services.settings.get("computer.blockedApps")).toEqual([
    "Notes",
    "com.apple.mail",
  ]);
  const relay = await writeSettingsPage(p, {
    type: "settings.page.set",
    page: "remote",
    row: "remote.relayUrl",
    value: "http://user:pw@example.com",
  });
  expect(relay).toMatchObject({
    ok: false,
    message: "Use a secure relay address without credentials",
  });
});
