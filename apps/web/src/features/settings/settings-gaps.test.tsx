import { facts } from "@ace/fake-daemon";
import { ProviderConfigurations } from "@ace/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

async function choose(label: string, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}
const configuration = (app: ReturnType<typeof harness>) =>
  ProviderConfigurations.parse(app.daemon.services.settings.get("providers.configuration"));

test("a global native permission default starts new threads in that mode", async () => {
  const app = harness();
  app.daemon.projects.seedFolders("/fake", [{ path: "/fake/settings-project", git: true }]);
  await app.open("/new?folder=%2Ffake%2Fsettings-project");
  await screen.findByRole("button", { name: "Project: settings-project" });
  cleanup();
  await app.open("/settings/general");
  await choose("Claude Code permissions", "Accept edits");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("permissions.providerModes")).toMatchObject({
      claude: "acceptEdits",
    }),
  );
  cleanup();
  await app.open("/new");
  expect(await screen.findByRole("button", { name: "Approvals: Accept edits" })).toBeTruthy();
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Check settings{Enter}",
  );
  await waitFor(() =>
    expect(app.daemon.services.settings.get("permissions.providerModes")).toMatchObject({
      claude: "acceptEdits",
    }),
  );
  await screen.findByRole("heading", { level: 1, name: "Check settings" });
  const snapshot = app.daemon.snapshot({ kind: "threads" });
  const started =
    snapshot?.kind === "threads"
      ? Object.values(snapshot.threads).find((thread) => thread.title === "Check settings")
      : undefined;
  expect(started?.permission?.effective).toBe("acceptEdits");
});

test("project permission overrides take precedence and reset to a changed global default", async () => {
  const app = harness();
  app.daemon.projects.seedFolders("/fake", [{ path: "/fake/settings-project", git: true }]);
  await app.open("/new?folder=%2Ffake%2Fsettings-project");
  await screen.findByRole("button", { name: "Project: settings-project" });
  const project = app.daemon.projects.list().workspaces[0];
  if (!project) throw new Error("Project missing");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "settings-project" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Project permissions…" }));
  await screen.findByRole("dialog", { name: "Permissions for settings-project" });
  await choose("Claude Code permissions", "Accept edits");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  cleanup();
  await app.open("/settings/general");
  await choose("Claude Code permissions", "Auto");
  cleanup();
  await app.open("/new");
  expect(await screen.findByRole("button", { name: "Approvals: Accept edits" })).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "settings-project" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Project permissions…" }));
  await choose("Claude Code permissions", "Use global default");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(await screen.findByRole("button", { name: "Approvals: Auto" })).toBeTruthy();
});

test("provider configuration changes visibility, stars and custom model choices and survives navigation", async () => {
  const storage = memoryKeyValue();
  storage.setItem("ace.models.favorites", JSON.stringify(["claude\u0000claude-opus-5-5"]));
  const app = harness({ storage });
  await app.open("/settings/providers/claude");
  await userEvent.click(await screen.findByRole("button", { name: "Show models" }));
  const models = await screen.findByRole("list", { name: "Models" });
  await waitFor(() => expect(storage.getItem("ace.models.favorites")).toBeNull());
  await userEvent.click(await within(models).findByRole("button", { name: "Star Sonnet 5.5" }));
  await userEvent.click(await within(models).findByRole("button", { name: "Hide Sonnet 5.5" }));
  await waitFor(() =>
    expect(configuration(app).find((row) => row.provider === "claude")).toMatchObject({
      favourites: expect.arrayContaining(["claude-sonnet-5-5"]),
      hiddenModels: ["claude-sonnet-5-5"],
    }),
  );
  const reply = await app.client.request({ type: "models.list", options: { provider: "claude" } });
  if (!("models" in reply.result)) throw new Error("Model list unavailable");
  expect(reply.result.models.find((model) => model.id === "claude-sonnet-5-5")).toMatchObject({
    hidden: true,
    favourite: true,
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add custom model" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Model name used by the CLI" }),
    "my-private-model",
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Display name" }), "My model");
  await userEvent.click(screen.getByRole("button", { name: "Add model" }));
  expect(await within(models).findByText("My model")).toBeTruthy();
  await userEvent.click(await screen.findByRole("switch", { name: "Only favourites" }));
  await waitFor(() => expect(configuration(app)[0]?.showOnlyFavourites).toBe(true));
  const filtered = await app.client.request({
    type: "models.list",
    options: { provider: "claude" },
  });
  if (!("models" in filtered.result)) throw new Error("Model list unavailable");
  expect(filtered.result.models.find((model) => model.id === "my-private-model")).toMatchObject({
    hidden: true,
    visibilityReason: "not_favourite",
  });
  await userEvent.click(await screen.findByRole("switch", { name: "Hide deprecated models" }));
  await waitFor(() => expect(configuration(app)[0]?.hideDeprecated).toBe(false));
  await userEvent.type(screen.getByRole("textbox", { name: "CLI path" }), "/tmp/fake-claude");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(configuration(app)[0]?.binaryPath).toBe("/tmp/fake-claude"));
  await userEvent.click(screen.getByRole("switch", { name: "Enable provider" }));
  await waitFor(() => expect(configuration(app)[0]?.enabled).toBe(false));
  const disabled = await app.client.request({
    type: "models.list",
    options: { provider: "claude" },
  });
  if (!("models" in disabled.result)) throw new Error("Model list unavailable");
  expect(
    disabled.result.models.every((model) => model.hidden && model.providerEnabled === false),
  ).toBe(true);
  cleanup();
  await app.open("/settings/general");
  cleanup();
  await app.open("/settings/providers/claude");
  expect(
    (await screen.findByRole("switch", { name: "Enable provider" })).getAttribute("aria-checked"),
  ).toBe("false");
  expect(screen.getByRole("textbox", { name: "CLI path" }).getAttribute("value")).toBe(
    "/tmp/fake-claude",
  );
});

test("allowed project folders round-trip and removing one stops browsing it", async () => {
  const app = harness();
  app.daemon.projects.seedFolders("/fake", [{ path: "/external/settings-project", git: true }], {
    roots: ["/fake", "/external"],
  });
  // Seed an actual outside directory, then restrict access as a real host does.
  app.daemon.services.settings.seed({ "projects.roots": ["/fake"] });
  await app.open("/settings/general");
  await screen.findByRole("textbox", { name: "Folder path" });
  const denied = await app.client.request({
    type: "projects.request",
    operation: { op: "fs.browse", path: "/external" },
  });
  expect(denied.result).toMatchObject({ kind: "error", code: "outside_project_roots" });
  await userEvent.type(await screen.findByRole("textbox", { name: "Folder path" }), "/external");
  await userEvent.click(screen.getByRole("button", { name: "Add folder" }));
  expect(await screen.findByRole("button", { name: "Remove /external" })).toBeTruthy();
  const allowed = await app.client.request({
    type: "projects.request",
    operation: { op: "fs.browse", path: "/external" },
  });
  expect(allowed.result.kind).toBe("directories");
  await userEvent.click(screen.getByRole("button", { name: "Remove /external" }));
  await waitFor(() =>
    expect(app.daemon.services.settings.get("projects.roots")).toEqual(["/fake"]),
  );
  const refused = await app.client.request({
    type: "projects.request",
    operation: { op: "fs.browse", path: "/external" },
  });
  expect(refused.result.kind).toBe("error");
});

test("a refused folder can be reviewed and allowed without opening Settings", async () => {
  const app = harness();
  app.daemon.projects.seedFolders("/fake", [{ path: "/external/settings-project", git: true }], {
    roots: ["/fake", "/external"],
  });
  app.daemon.services.settings.seed({ "projects.roots": ["/fake"] });
  await app.open("/new?folder=%2Fexternal%2Fsettings-project");
  await screen.findByRole("heading", { name: "Couldn't open settings-project" });
  await userEvent.click(await screen.findByRole("button", { name: "Choose another folder…" }));
  await userEvent.click(await screen.findByRole("button", { name: "Allow this folder…" }));
  const review = await screen.findByRole("dialog", { name: "Allow this folder?" });
  expect(within(review).getByText("/external")).toBeTruthy();
  expect(app.daemon.services.settings.get("projects.roots")).toEqual(["/fake"]);
  await userEvent.click(within(review).getByRole("button", { name: "Allow folder" }));
  expect(await screen.findByRole("option", { name: /^settings-project/ })).toBeTruthy();
  expect(app.daemon.services.settings.get("projects.roots")).toEqual(["/fake", "/external"]);
});

test("settle-on-close moves finished threads but keeps work in progress active", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "threads.autoSettleAfter": "never" });
  for (const [id, done] of [
    ["finished-pr", true],
    ["working-pr", false],
  ] as const) {
    app
      .play({
        thread: {
          id,
          workspaceId: "project",
          title: id,
          provider: "claude",
          details: { linkedPr: { number: 1, state: "closed" } },
        },
        steps: [
          {
            kind: "facts",
            facts: [
              facts.rootAgent("claude"),
              facts.turn("root"),
              ...(done ? [facts.endTurn("root")] : []),
            ],
          },
        ],
      })
      .runUntilBlocked();
  }
  await app.open("/settings/general");
  await userEvent.click(await screen.findByRole("switch", { name: "Settle when the PR closes" }));
  await waitFor(() => expect(app.daemon.services.settings.get("threads.settleOnClose")).toBe(true));
  app.daemon.sweep();
  const snapshot = app.daemon.snapshot({ kind: "threads" });
  if (snapshot?.kind !== "threads") throw new Error("Threads unavailable");
  expect(snapshot.threads["finished-pr"]?.settledAt).toBeDefined();
  expect(snapshot.threads["working-pr"]?.settledAt).toBeUndefined();
  cleanup();
  await app.open("/settings/general");
  expect(
    (await screen.findByRole("switch", { name: "Settle when the PR closes" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
});
