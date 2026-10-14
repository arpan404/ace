import { workbench } from "@ace/fake-daemon";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { fakeClient, harness } from "@/test/harness.tsx";
import { chooseModel, closeModelControl } from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 10000 });

function made() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  return app;
}
const menu = async () =>
  (await screen.findAllByRole("menuitemradio")).map((item) => item.getAttribute("aria-label"));
const created = (app: ReturnType<typeof made>, title: string) => {
  const view = app.daemon.snapshot({ kind: "threads" });
  return view?.kind === "threads"
    ? Object.values(view.threads).find((thread) => thread.title === title)
    : undefined;
};

test("the access chip offers ace's four modes, starting in Auto review on a first run", async () => {
  const app = made();
  await app.open("/new?project=relay");
  await userEvent.click(await screen.findByRole("button", { name: "Access: Auto review" }));
  expect(await menu()).toEqual(["Read-only", "Ask", "Auto review", "Full access"]);
});

test("a provider that can't express a mode doesn't list it, and a default steps down stricter", async () => {
  const app = made();
  app.daemon.services.settings.write("access.defaultMode", "full-access");
  await app.open("/new?project=relay");
  await screen.findByRole("button", { name: "Access: Full access" });
  await chooseModel("Composer 2.5", "Cursor", /^Model: Opus 5.5/);
  await closeModelControl();
  // Cursor has no human-approval path: no Read-only or Ask.
  await userEvent.click(await screen.findByRole("button", { name: "Access: Full access" }));
  expect(await menu()).toEqual(["Auto review", "Full access"]);
  await userEvent.keyboard("{Escape}");
  app.daemon.services.settings.write("access.defaultMode", "ask");
  // Nothing as strict as Ask: sending waits for a choice rather than running looser.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true"),
  );
});

test("a chosen mode starts the thread and becomes this daemon's default for new threads", async () => {
  const app = made();
  await app.open("/new?project=relay");
  await userEvent.click(await screen.findByRole("button", { name: "Access: Auto review" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Ask" }));
  const input = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(input, "Ask before anything{Enter}");
  await waitFor(() =>
    expect(created(app, "Ask before anything")?.permission).toMatchObject({
      override: "ask",
      effective: "ask",
    }),
  );
  expect(app.daemon.services.settings.get("access.defaultMode")).toBe("ask");
});

test("a project's default access comes before this daemon's", async () => {
  const app = made();
  app.daemon.services.settings.write("access.defaultMode", "full-access");
  const relay = app.daemon.projects.list().workspaces.find((project) => project.id === "relay");
  if (!relay) throw new Error("the workbench lists relay");
  const other = fakeClient(app.daemon);
  await other.start();
  await vi.waitFor(() => expect(other.state).toBe("ready"));
  await other.projects.update({
    workspaceId: relay.id,
    name: relay.name,
    defaults: { access: "read-only" },
  });
  await app.open("/new?project=relay");
  expect(await screen.findByRole("button", { name: "Access: Read-only" })).toBeTruthy();
});
