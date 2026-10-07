import { deckRuns, workbenchServices } from "@ace/fake-daemon";
import { CommandId, DeviceId, ServerMessage } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const escalation = "Escalated: Defer the first relay sync";
const question = "Precompile Hermes bytecode needs your answer";
const card = (name: RegExp) => screen.getByRole("button", { name });

/** The design's daemon: four decks on the conductor, served over the wire. */
async function open(path: string) {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(path);
  return app;
}

test("a deck shows when it started and changed, and how long its decision has waited", async () => {
  await open("/deck/relay-streams");

  const gate = await screen.findByRole("region", {
    name: "Merge needs your approval: Server-side replay cursor",
  });
  expect(within(gate).getByText(/^Waiting 22m/)).toBeTruthy();
  expect(screen.getByText("Started 3h ago · updated 22m ago")).toBeTruthy();
});

test("a worker's question waits behind the escalation, and is answered right on the deck", async () => {
  const app = await open("/deck/mobile-cold-start");
  const first = await screen.findByRole("region", { name: escalation });
  expect(within(first).getByText("Decision 1 of 2")).toBeTruthy();
  expect(card(/Precompile Hermes bytecode/).textContent).toContain("Waiting for you");
  // Every open decision can be listed and taken in any order.
  await userEvent.click(within(first).getByRole("button", { name: "See all 2" }));
  expect(
    within(within(first).getByRole("list", { name: "Open decisions" }))
      .getAllByRole("button")
      .map((entry) => entry.textContent),
  ).toEqual([expect.stringMatching(/^Escalated: Defer/), expect.stringMatching(/^Precompile/)]);

  await userEvent.click(within(first).getByRole("button", { name: /^Retry card/ }));
  const asking = await screen.findByRole("region", { name: question });
  await userEvent.click(await within(asking).findByRole("radio", { name: "Ship it in the APK" }));
  await userEvent.click(within(asking).getByRole("button", { name: "Answer" }));

  await waitFor(() => expect(screen.queryByRole("region", { name: question })).toBeNull());
  expect(card(/Precompile Hermes bytecode/).textContent).toContain("Working");
  expect(
    app.daemon.resolution("mobile-cold-start.hermes-bytecode.thread", "ask.hermes-bytecode"),
  ).toEqual({ kind: "question", answers: { choice: ["apk"] } });
});

test("a deck follows a change another device made, from the daemon's push alone", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.command({
    id: CommandId.parse("phone-pause"),
    deviceId: DeviceId.parse("phone"),
    payload: { type: "conductor.pause", runId: "mobile-cold-start" },
  });

  expect(await screen.findByRole("button", { name: "Resume deck" })).toBeTruthy();
  expect(card(/Lazy-load fonts and icons/).textContent).toContain("Paused");
});

test("cancelling a deck asks first, then stops it and keeps its threads to read", async () => {
  await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel deck…" }));
  const confirm = await screen.findByRole("dialog", { name: "Cancel this deck?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Keep it running" }));
  expect(screen.getByRole("button", { name: "Pause deck" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel deck…" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Cancel this deck?" })).getByRole("button", {
      name: "Cancel deck",
    }),
  );

  expect(await screen.findByText("This deck was cancelled.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pause deck" })).toBeNull();
  expect(screen.queryByRole("region", { name: escalation })).toBeNull();
  const decks = screen.getByRole("navigation", { name: "Decks" });
  expect(
    within(within(decks).getByRole("region", { name: "Finished" })).getByText(
      "Mobile cold start under 1s",
    ),
  ).toBeTruthy();
});

test("a deck the daemon couldn't run says why in words, and trying again clears it", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "conductor_execution_failed");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The deck can't take its next step.");
  await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByText("The deck can't take its next step.")).toBeNull());
  expect(screen.getByRole("button", { name: "Pause deck" })).toBeTruthy();
});

test("a deck whose project is gone offers to cancel it, since trying again can't help", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "deck_workspace_not_found");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The deck's project is no longer on this daemon.");
  expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
  await userEvent.click(within(alert).getByRole("button", { name: "Cancel deck…" }));
  expect(await screen.findByRole("dialog", { name: "Cancel this deck?" })).toBeTruthy();
});

test("waiting for a free account is a calm status, not a stop", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "deck_capacity_wait");

  const status = await screen.findByText("Waiting for a free account.");
  expect(status.closest('[role="status"]')).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("New deck says which model and accounts each role runs on before it starts", async () => {
  await open("/deck/new");
  const form = await screen.findByRole("form", { name: "New deck" });
  expect(await within(form).findByText(/^Workers run .+ on Claude Code/)).toBeTruthy();
});

test("with more moving decks than live watches, the open deck still follows the daemon's pushes", async () => {
  const app = harness();
  const now = Date.now();
  const base = deckRuns(now)[1];
  if (!base) throw new Error("Seed deck missing");
  // Eight decks dealing at once; the daemon serves six watches to this screen.
  const moving = Array.from({ length: 8 }, (_, index) => ({
    ...base,
    id: `moving-${index}`,
    title: `Moving deck ${index}`,
    goal: `Moving deck ${index}. Keep dealing.`,
    gate: null,
    updatedAt: now - (index + 1) * 60_000,
  }));
  app.daemon.seedServices({ decks: moving });
  await app.open("/deck/moving-7");
  await screen.findByRole("heading", { level: 1, name: "Moving deck 7" });

  app.daemon.command({
    id: CommandId.parse("phone-pause-7"),
    deviceId: DeviceId.parse("phone"),
    payload: { type: "conductor.pause", runId: "moving-7" },
  });

  expect(await screen.findByRole("button", { name: "Resume deck" })).toBeTruthy();
});

test.each([
  ["deck_ci_pending", "Waiting for CI."],
  ["deck_migration_pending", "Waiting for account migration."],
  ["deck_forge_executor_unavailable", "Waiting for the PR service."],
  ["git_quarantined", "Waiting for Git recovery."],
])("%s is a calm wait with its own wording", async (code, title) => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });
  app.daemon.failDeck("mobile-cold-start", code);
  const status = await screen.findByText(title);
  expect(status.closest('[role="status"]')).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByText("Stopped")).toBeNull();
});

test("unknown execution failures never display a raw daemon code", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });
  app.daemon.failDeck("mobile-cold-start", "deck_unfamiliar_internal_error");
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "deck_unfamiliar_internal_error",
  );
});

test.each(["relay-streams", "codex-app-server-048"])(
  "%s stays loading while only its summary has arrived",
  async (id) => {
    const app = harness();
    app.daemon.seedServices(workbenchServices(Date.now()));
    const connect = app.daemon.connect.bind(app.daemon);
    const held: (() => void)[] = [];
    let holding = true;
    app.daemon.connect = (wire) =>
      connect({
        ...wire,
        send(text) {
          const message = ServerMessage.parse(JSON.parse(text));
          if (holding && message.type === "conductor.result" && message.run?.id === id)
            held.push(() => wire.send(text));
          else wire.send(text);
        },
      });
    await app.open(`/deck/${id}`);
    // The list and accounts have arrived; only the full view is held at the socket edge.
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    await screen.findByRole("navigation", { name: "Decks" });
    const main = within(screen.getByRole("main"));
    expect(main.queryByText("Drafting the plan")).toBeNull();
    expect(main.queryByText("This deck has no cards.")).toBeNull();
    expect(main.getByLabelText("Loading deck")).toBeTruthy();
    holding = false;
    for (const release of held.splice(0)) release();
    await screen.findByRole("heading", { name: "Cards" });
    expect(within(screen.getByRole("main")).queryByLabelText("Loading deck")).toBeNull();
  },
);
