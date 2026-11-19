import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, openProfile, spadeApp, withEndpoint } from "@/test/spade.ts";

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

test("a routine's run names itself in its time line, not as the person, and a quiet heartbeat shows nothing", async () => {
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
  expect(
    (await chat.findByRole("separator", { name: /^Daily briefing · Today \d/ })).textContent,
  ).toMatch(/^Daily briefing · Today \d{1,2}:\d{2}/);
  expect(chat.queryByRole("article", { name: "You" })).toBeNull();
  // The bot's one bubble; the heartbeat left none.
  const bubbles = chat.getAllByRole("article");
  expect(bubbles).toHaveLength(1);
  expect(within(bubbles[0] ?? document.body).getByText("Three meetings today.")).toBeTruthy();
});

test("the person adds, pauses and edits a bot's routines in its profile, and turns its heartbeat on", async () => {
  const { spade } = await spadeApp("/spade", (seed) => {
    withEndpoint(seed);
    seed.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    seed.addAgent({ id: "scout", name: "Scout" });
  });
  await userEvent.click(await botRow("Scout"));
  await openProfile("Scout");
  const heading = await screen.findByRole("heading", { name: "Routines" });
  const section = within(heading.closest("section") ?? document.body);

  // Add routine opens the editor where the row was.
  await userEvent.click(await section.findByRole("button", { name: "Add routine" }));
  const form = within(section.getByRole("form", { name: "New routine" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Daily briefing");
  await userEvent.type(form.getByRole("textbox", { name: "Each time" }), "Brief me.");
  await userEvent.type(form.getByRole("textbox", { name: "Every" }), "whenever");
  await userEvent.click(form.getByRole("button", { name: "Add routine" }));
  // Spade's own words on what it couldn't read.
  expect((await form.findByRole("alert")).textContent).toMatch(/Could not read the schedule/);
  await userEvent.clear(form.getByRole("textbox", { name: "Every" }));
  await userEvent.type(form.getByRole("textbox", { name: "Every" }), "daily at 9:00");
  await userEvent.click(form.getByRole("button", { name: "Add routine" }));
  await waitFor(() => expect(section.queryByRole("form")).toBeNull());
  // "next tomorrow 9:00": when it runs, in words.
  expect(await section.findByText(/^Every day at 9:00 · next (tomorrow |\d)/)).toBeTruthy();
  expect(spade.routines.routines[0]?.time_zone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  // Its switch pauses it, and its row says so.
  await userEvent.click(section.getByRole("switch", { name: "Daily briefing" }));
  expect(await section.findByText("Paused")).toBeTruthy();
  expect(spade.routines.routines[0]?.paused).toBe(true);

  await userEvent.click(section.getByRole("button", { name: "Edit Daily briefing" }));
  const edit = within(section.getByRole("form", { name: "Edit Daily briefing" }));
  await userEvent.click(edit.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(spade.routines.routines).toEqual([]));

  // Turning the heartbeat on asks for its checklist first.
  await userEvent.click(section.getByRole("switch", { name: "Heartbeat" }));
  const beat = within(section.getByRole("form", { name: "Edit heartbeat" }));
  await userEvent.type(beat.getByRole("textbox", { name: "Checklist" }), "Is the build green?");
  await userEvent.click(beat.getByRole("button", { name: "Turn on" }));
  expect(await section.findByText(/^Every 30 minutes · next (tomorrow |\d)/)).toBeTruthy();
  expect(spade.routines.heartbeats.get("scout")?.checklist).toBe("Is the build green?");
});

test("Esc puts an open routine back without saving it", async () => {
  const { spade } = await spadeApp("/spade/scout?profile=details", (seed) => {
    withEndpoint(seed);
    seed.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    seed.addAgent({ id: "scout", name: "Scout" });
  });
  await userEvent.click(await screen.findByRole("button", { name: "Add routine" }));
  const form = within(screen.getByRole("form", { name: "New routine" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Daily briefing{Escape}");
  await waitFor(() => expect(screen.queryByRole("form", { name: "New routine" })).toBeNull());
  expect(spade.routines.routines).toEqual([]);
});
