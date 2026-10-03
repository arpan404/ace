import { workbenchServices } from "@ace/fake-daemon";
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
  await open("/deck/relay-streams");

  const gate = await screen.findByRole("region", { name: "Deck plan needs your approval" });
  expect(within(gate).getByText(/^Waiting 22m/)).toBeTruthy();
  expect(screen.getByText("Started 3h ago · updated 22m ago")).toBeTruthy();
});

test("a worker's question waits behind the escalation, and is answered right on the deck", async () => {
  const app = await open("/deck/mobile-cold-start");
  const first = await screen.findByRole("region", { name: escalation });
  expect(
    within(first).getByText("1 more decision waits after this one", { exact: false }),
  ).toBeTruthy();
  expect(card(/Precompile Hermes bytecode/).textContent).toContain("Waiting for you");

  await userEvent.click(within(first).getByRole("button", { name: "Approve" }));
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

test("a deck the daemon couldn't run says why in words, and resuming clears it", async () => {
  const app = await open("/deck/mobile-cold-start");
  await screen.findByRole("region", { name: escalation });

  app.daemon.failDeck("mobile-cold-start", "deck_workspace_not_found");

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The deck's project is no longer on this daemon.");
  await userEvent.click(screen.getByRole("button", { name: "Resume deck" }));
  await waitFor(() => expect(screen.queryByText("The deck stopped.")).toBeNull());
  expect(screen.getByRole("button", { name: "Pause deck" })).toBeTruthy();
});

test("New deck says which model and accounts each role runs on before it starts", async () => {
  await open("/deck/new");
  const form = await screen.findByRole("form", { name: "New deck" });
  expect(await within(form).findByText(/^Workers run .+ on Claude Code/)).toBeTruthy();
});
