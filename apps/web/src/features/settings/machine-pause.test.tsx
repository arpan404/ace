import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import { facts } from "@ace/fake-daemon";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const pauseRow = async () => {
  const group = await screen.findByRole("region", { name: "New work" });
  return within(group);
};

test("Pause new work on this computer's Fleet page shows the Paused banner, and Resume clears it", async () => {
  const app = harness();
  await app.open("/settings/remote/primary");
  const row = await pauseRow();
  expect(await row.findByText("Taking new work")).toBeTruthy();
  expect(screen.queryByText("New work is on hold.")).toBeNull();

  await userEvent.click(row.getByRole("button", { name: "Pause new work" }));
  await waitFor(() => expect(app.daemon.admission.held("user")).toBe(true));
  expect(await screen.findByText("New work is on hold.")).toBeTruthy();
  expect(await row.findByText("New work paused · nothing is running")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(app.daemon.admission.held("user")).toBe(false));
  await waitFor(() => expect(screen.queryByText("New work is on hold.")).toBeNull());
  expect(await row.findByRole("button", { name: "Pause new work" })).toBeTruthy();
});

test("a pause made elsewhere reaches an open Fleet page, and an update's hold keeps Resume off", async () => {
  const app = harness();
  await app.open("/settings/remote/primary");
  const row = await pauseRow();
  await row.findByText("Taking new work");
  app.daemon.admission.set("user", true);
  expect(await screen.findByText("New work is on hold.")).toBeTruthy();
  const resume = await row.findByRole("button", { name: "Resume new work" });
  expect(resume.hasAttribute("disabled")).toBe(false);
  app.daemon.admission.set("update", true);
  await waitFor(() =>
    expect(row.getByRole("button", { name: "Resume new work" }).hasAttribute("disabled")).toBe(
      true,
    ),
  );
});

test("a pause from the tray is visible across pages and Resume reopens admission", async () => {
  const app = harness();
  app
    .play({
      thread: {
        id: "paused-example",
        workspaceId: "project",
        title: "Pause example",
        provider: "claude",
      },
      steps: [{ kind: "facts", facts: [facts.rootAgent("claude"), facts.turn("root")] }],
    })
    .runUntilBlocked();
  // The tray holds the daemon's own gate; the app reads it from the daemon.
  app.daemon.admission.set("user", true);
  await app.open("/settings/general");
  expect(await screen.findByText("Paused", { exact: true })).toBeTruthy();
  cleanup();
  await app.open("/t/paused-example");
  await screen.findByRole("heading", { level: 1, name: "Pause example" });
  expect(await screen.findByText("Paused", { exact: true })).toBeTruthy();
  cleanup();
  await app.open("/settings/appearance");
  await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(app.daemon.admission.held("user")).toBe(false));
  await waitFor(() => expect(screen.queryByText("New work is on hold.")).toBeNull());
});

test("searching Settings for pause opens this computer's Fleet page at the Pause new work row", async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  onTestFinished(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  await harness().open("/settings/general");
  await userEvent.type(await screen.findByRole("searchbox", { name: "Search settings" }), "pause");
  const results = screen.getByRole("region", { name: "Matching settings" });
  await userEvent.click(within(results).getByRole("link", { name: /^Pause new work/ }));
  const row = await pauseRow();
  expect(await row.findByRole("button", { name: "Pause new work" })).toBeTruthy();
  await waitFor(() => expect(scrolled).toContain(document.getElementById("machine.pause")));
});

test("another machine's page pauses that machine only, and a read-only pairing says why it can't", async () => {
  const app = harness({
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "studio", name: "Studio", scopes: ["read"] },
    ],
  });
  const daemon = (id: string) => {
    const found = app.machines.get(id);
    if (!found) throw new Error(`Missing machine ${id}`);
    return found;
  };
  await app.open("/settings/remote/build");
  const row = await pauseRow();
  await userEvent.click(await row.findByRole("button", { name: "Pause new work" }));
  await waitFor(() => expect(daemon("build").admission.held("user")).toBe(true));
  expect(app.daemon.admission.held("user")).toBe(false);
  // The banner is this window's machine; it stays clear.
  expect(screen.queryByText("New work is on hold.")).toBeNull();
  cleanup();

  await app.open("/settings/remote/studio");
  const readOnly = await pauseRow();
  await userEvent.click(await readOnly.findByRole("button", { name: "Pause new work" }));
  expect(
    await readOnly.findByText(
      "This window can view Studio but can't pause it. Pair it with full access.",
    ),
  ).toBeTruthy();
  expect(daemon("studio").admission.held("user")).toBe(false);
});

test("the Paused banner clears when the daemon goes away, and stays clear when it comes back unpaused", async () => {
  const app = harness();
  app.daemon.admission.set("user", true);
  await app.open("/settings/remote/primary");
  expect(await screen.findByText("New work is on hold.")).toBeTruthy();

  app.daemon.refuseConnections(true);
  app.daemon.disconnectAll();
  await waitFor(() => expect(screen.queryByText("New work is on hold.")).toBeNull());

  // It crashed while paused and restarted without the pause.
  app.daemon.admission.set("user", false);
  app.daemon.refuseConnections(false);
  await userEvent.click(await screen.findByRole("button", { name: "Retry now" }));
  await waitFor(() => expect(app.client.state).toBe("ready"));
  const row = await pauseRow();
  expect(await row.findByText("Taking new work")).toBeTruthy();
  expect(screen.queryByText("New work is on hold.")).toBeNull();
});
