import { deckRuns, workbenchServices } from "@ace/fake-daemon";
import { CommandId, DeviceId } from "@ace/protocol";
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
  await open("/offsets/relay-streams");

  const gate = await screen.findByRole("region", {
    name: "Merge needs your approval: Server-side replay cursor",
  });
  expect(within(gate).getByText(/^Waiting 22m/)).toBeTruthy();
  expect(screen.getByText("Started 3h ago · updated 22m ago")).toBeTruthy();
});

test("a worker's question waits behind the escalation, and is answered right on the deck", async () => {
  const app = await open("/offsets/mobile-cold-start");
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
  const app = await open("/offsets/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.command({
    id: CommandId.parse("phone-pause"),
    deviceId: DeviceId.parse("phone"),
    payload: { type: "conductor.pause", runId: "mobile-cold-start" },
  });

  expect(await screen.findByRole("button", { name: "Resume offset" })).toBeTruthy();
  expect(card(/Lazy-load fonts and icons/).textContent).toContain("Paused");
});

test("cancelling a deck asks first, then stops it and keeps its threads to read", async () => {
  await open("/offsets/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel offset…" }));
  const confirm = await screen.findByRole("dialog", { name: "Cancel this offset?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Keep it running" }));
  expect(screen.getByRole("button", { name: "Pause offset" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel offset…" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Cancel this offset?" })).getByRole("button", {
      name: "Cancel offset",
    }),
  );

  expect(await screen.findByText("This offset was cancelled.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pause offset" })).toBeNull();
  expect(screen.queryByRole("region", { name: escalation })).toBeNull();
  const decks = screen.getByRole("navigation", { name: "Offsets" });
  expect(
    within(within(decks).getByRole("region", { name: "Finished" })).getByText(
      "Mobile cold start under 1s",
    ),
  ).toBeTruthy();
});

test("a deck the daemon couldn't run says why in words, and trying again clears it", async () => {
  const app = await open("/offsets/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "conductor_execution_failed");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The offset can't take its next step.");
  await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.queryByText("The offset can't take its next step.")).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Pause offset" })).toBeTruthy();
});

test("a deck whose project is gone offers to cancel it, since trying again can't help", async () => {
  const app = await open("/offsets/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "deck_workspace_not_found");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The offset's project is no longer on this daemon.");
  expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
  await userEvent.click(within(alert).getByRole("button", { name: "Cancel offset…" }));
  expect(await screen.findByRole("dialog", { name: "Cancel this offset?" })).toBeTruthy();
});

test("waiting for a free account is a calm status, not a stop", async () => {
  const app = await open("/offsets/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "deck_capacity_wait");

  const status = await screen.findByText("Waiting for a free account.");
  expect(status.closest('[role="status"]')).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("New deck says which model and accounts each role runs on before it starts", async () => {
  await open("/offsets/new");
  const form = await screen.findByRole("form", { name: "New offset" });
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
  await app.open("/offsets/moving-7");
  await screen.findByRole("heading", { level: 1, name: "Moving deck 7" });

  app.daemon.command({
    id: CommandId.parse("phone-pause-7"),
    deviceId: DeviceId.parse("phone"),
    payload: { type: "conductor.pause", runId: "moving-7" },
  });

  expect(await screen.findByRole("button", { name: "Resume offset" })).toBeTruthy();
});
