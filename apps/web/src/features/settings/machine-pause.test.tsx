import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import { facts } from "@ace/fake-daemon";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

/** The machine page's header button that pauses or resumes new work. */
const pauseButton = (name: "Pause new work" | "Resume new work") =>
  screen.findByRole("button", { name });

test("Pause new work in this computer's page header shows the Paused banner and a paused line, and Resume clears both", async () => {
  const app = harness();
  await app.open("/settings/remote/primary");
  const pause = await pauseButton("Pause new work");
  expect(screen.queryByText("New work is on hold.")).toBeNull();

  await userEvent.click(pause);
  await waitFor(() => expect(app.daemon.admission.held("user")).toBe(true));
  expect(await screen.findByText("New work is on hold.")).toBeTruthy();
  expect(await screen.findByText("New work paused · nothing is running")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(app.daemon.admission.held("user")).toBe(false));
  await waitFor(() => expect(screen.queryByText("New work is on hold.")).toBeNull());
  expect(await pauseButton("Pause new work")).toBeTruthy();
  expect(screen.queryByText("New work paused · nothing is running")).toBeNull();
});

test("a pause made elsewhere reaches an open machine page, and an update's hold keeps Resume off", async () => {
  const app = harness();
  await app.open("/settings/remote/primary");
  await pauseButton("Pause new work");
  app.daemon.admission.set("user", true);
  expect(await screen.findByText("New work is on hold.")).toBeTruthy();
  const resume = await pauseButton("Resume new work");
  expect(resume.hasAttribute("disabled")).toBe(false);
  app.daemon.admission.set("update", true);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Resume new work" }).hasAttribute("disabled")).toBe(
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

test("searching Settings for pause opens this computer's page at its Pause new work button", async () => {
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
  const pause = await pauseButton("Pause new work");
  await waitFor(() => expect(scrolled).toContain(pause));
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
  await userEvent.click(await pauseButton("Pause new work"));
  await waitFor(() => expect(daemon("build").admission.held("user")).toBe(true));
  expect(app.daemon.admission.held("user")).toBe(false);
  // The banner is this window's machine; it stays clear.
  expect(screen.queryByText("New work is on hold.")).toBeNull();
  cleanup();

  await app.open("/settings/remote/studio");
  await userEvent.click(await pauseButton("Pause new work"));
  expect(
    await screen.findByText(
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
  expect(await pauseButton("Pause new work")).toBeTruthy();
  expect(screen.queryByText("New work is on hold.")).toBeNull();
});
