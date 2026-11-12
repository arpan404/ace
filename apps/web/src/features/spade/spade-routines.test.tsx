import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const routineMessage = (heartbeat: boolean, label: string) => ({
  type: "user_message",
  text: heartbeat ? "Heartbeat check." : "Brief me on the day.",
  from_routine: {
    id: heartbeat ? "hb_1" : "rt_1",
    name: heartbeat ? "Heartbeat" : "Daily briefing",
    run: `run_${label}`,
    label,
    heartbeat,
  },
});

test("a routine's message shows as its label, not as the person, and a quiet heartbeat shows nothing", async () => {
  await spadeApp("/spade", (spade) => {
    withEndpoint(spade);
    spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    const scout = spade.addAgent({ id: "scout", name: "Scout" });
    const c = scout.conversation;
    spade.store(c, routineMessage(false, "9:00"));
    spade.store(c, { type: "reply_started", reply: "r1" });
    spade.store(c, { type: "reply_finished", reply: "r1", text: "Three meetings today." });
    spade.store(c, routineMessage(true, "9:30"));
    spade.store(c, { type: "reply_started", reply: "r2" });
    spade.store(c, { type: "reply_finished", reply: "r2", text: "[quiet]" });
  });
  await userEvent.click(await botRow("Scout"));
  const chat = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  expect((await chat.findByRole("note")).textContent).toBe("Daily briefing · 9:00");
  expect(chat.queryByRole("article", { name: "You" })).toBeNull();
  // The face's initials sit beside the bot's one bubble; the heartbeat left none.
  expect(chat.getAllByRole("article").map((bubble) => bubble.textContent)).toEqual([
    "SCThree meetings today.",
  ]);
});

test("the person adds, pauses and edits a bot's routines from its menu, and turns its heartbeat on", async () => {
  const { spade } = await spadeApp("/spade", (seed) => {
    withEndpoint(seed);
    seed.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    seed.addAgent({ id: "scout", name: "Scout" });
  });
  await userEvent.click(await botRow("Scout"));
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Routines" }));

  await userEvent.click(await screen.findByRole("button", { name: "Add routine" }));
  const form = within(await screen.findByRole("dialog", { name: "New routine" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Daily briefing");
  await userEvent.type(form.getByRole("textbox", { name: "Instruction" }), "Brief me.");
  await userEvent.type(form.getByRole("textbox", { name: "Schedule" }), "whenever");
  await userEvent.click(form.getByRole("button", { name: "Add routine" }));
  // Spade's own words on what it couldn't read.
  expect((await form.findByRole("alert")).textContent).toMatch(/Could not read the schedule/);
  await userEvent.clear(form.getByRole("textbox", { name: "Schedule" }));
  await userEvent.type(form.getByRole("textbox", { name: "Schedule" }), "daily at 9:00");
  await userEvent.click(form.getByRole("button", { name: "Add routine" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // "Next: tomorrow 9:00", never "Next Tomorrow 9:00".
  expect(await screen.findByText(/^Every day at 9:00 · Next: (tomorrow |\d)/)).toBeTruthy();
  expect(spade.routines.routines[0]?.time_zone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  await userEvent.click(screen.getByRole("button", { name: "Pause Daily briefing" }));
  expect(await screen.findByText("Every day at 9:00 · Paused")).toBeTruthy();
  expect(spade.routines.routines[0]?.paused).toBe(true);

  await userEvent.click(screen.getByRole("button", { name: "Edit Daily briefing" }));
  const edit = within(await screen.findByRole("dialog", { name: "Edit routine" }));
  await userEvent.click(edit.getByRole("button", { name: "Delete routine" }));
  await waitFor(() => expect(spade.routines.routines).toEqual([]));

  // Turning the heartbeat on asks for its checklist first.
  await userEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
  const beat = within(await screen.findByRole("dialog", { name: "Heartbeat" }));
  await userEvent.type(beat.getByRole("textbox", { name: "Checklist" }), "Is the build green?");
  await userEvent.click(beat.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/^Every 30 minutes · Next: (tomorrow |\d)/)).toBeTruthy();
  expect(spade.routines.heartbeats.get("scout")?.checklist).toBe("Is the build green?");
});
