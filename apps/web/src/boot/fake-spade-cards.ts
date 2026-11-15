import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, questions: Trips asks a card of three (a text field, checks, yes or no) and
 * waits on it, after one it was answered, one left for later and a helper's line; Lessons waits
 * on one pick-one question; Watcher has a command it was allowed and waits on another it may
 * allow always; Daily waits on a lone yes-or-no question. Every card kind and state the chat
 * draws, for checking it by eye.
 */
export function seedFakeCards(here: FakeSpadeApi) {
  const trips = here.addAgent({
    id: "trips",
    name: "Trips",
    task: "Plan the Lisbon trip in May.",
  });
  here.store(trips.conversation, {
    type: "user_message",
    text: "Plan Lisbon for the 14th to the 18th.",
  });
  // Asked and answered in one reply that then finished.
  here.store(trips.conversation, { type: "reply_started", reply: "r-trips-pace" });
  here.store(trips.conversation, {
    type: "step_finished",
    reply: "r-trips-pace",
    text: "",
    calls: [{ id: "q-pace", name: "ask_user" }],
  });
  here.store(trips.conversation, {
    type: "question_asked",
    reply: "r-trips-pace",
    call_id: "q-pace",
    question: "How busy should the days be?",
    questions: [
      {
        prompt: "How busy should the days be?",
        kind: "choice",
        options: [
          { label: "Slow", detail: "One thing a day, long lunches" },
          { label: "Full", detail: "Museums in the morning, walks after" },
        ],
      },
    ],
  });
  here.store(trips.conversation, {
    type: "question_answered",
    call_id: "q-pace",
    answers: ["Slow"],
  });
  here.store(trips.conversation, { type: "reply_finished", reply: "r-trips-pace", text: "" });
  here.status(trips, "idle", null);
  here.card(
    trips,
    "q-budget",
    [{ prompt: "What's the most a night should cost?", kind: "number", unit: "€" }],
    true,
  );
  here.store(trips.conversation, { type: "reply_started", reply: "r-trips-helper" });
  here.store(trips.conversation, {
    type: "step_finished",
    reply: "r-trips-helper",
    text: "I'll have a helper check what's on that week.",
    calls: [
      {
        id: "h-events",
        name: "helper",
        arguments: { task: "Find what's on in Lisbon, 14–18 May" },
      },
    ],
  });
  here.store(trips.conversation, {
    type: "job_started",
    reply: "r-trips-helper",
    job: "h-events",
    name: "helper",
  });
  here.store(trips.conversation, {
    type: "job_finished",
    job: "h-events",
    name: "helper",
    content:
      "Found 3 things on that week: a fado night, the Feira do Livro opening, a tram strike on the 16th.",
  });
  here.store(trips.conversation, { type: "reply_finished", reply: "r-trips-helper", text: "" });
  here.card(trips, "q-plan", [
    {
      prompt: "Which neighbourhood should the hotel be in?",
      kind: "text",
      placeholder: "Alfama, Chiado…",
    },
    {
      prompt: "What should I book ahead? Up to two.",
      kind: "choices",
      options: ["The fado night", "A day trip to Sintra", "Tickets for the tile museum"],
      max: 2,
    },
    { prompt: "Book the 9:40 flight on the 14th?", kind: "confirm" },
  ]);

  const lessons = here.addAgent({ id: "lessons", name: "Lessons", task: "Teach me Portuguese." });
  here.reply(lessons, "Today's word: **saudade**, a longing for something you love that is gone.");
  here.card(lessons, "q-word", [
    {
      prompt: "Which sentence uses it right?",
      kind: "choice",
      options: [
        { label: "Tenho saudade de Lisboa.", detail: "I miss Lisbon." },
        { label: "Estou saudade hoje.", detail: undefined },
        { label: "A saudade é uma cidade." },
      ],
    },
  ]);

  const watcher = here.addAgent({
    id: "watcher",
    name: "Watcher",
    task: "Watch my pull requests.",
  });
  here.store(watcher.conversation, { type: "user_message", text: "What's open on ace?" });
  here.store(watcher.conversation, { type: "reply_started", reply: "r-watch-list" });
  here.store(watcher.conversation, {
    type: "step_finished",
    reply: "r-watch-list",
    text: "",
    calls: [{ id: "w-curl", name: "shell" }],
  });
  here.store(watcher.conversation, {
    type: "approval_requested",
    reply: "r-watch-list",
    call_id: "w-curl",
    name: "shell",
    arguments: { command: "curl -s https://api.github.com/repos/arpan404/ace/pulls" },
  });
  here.store(watcher.conversation, {
    type: "approval_answered",
    reply: "r-watch-list",
    call_id: "w-curl",
    allowed: true,
    always: false,
  });
  here.store(watcher.conversation, {
    type: "reply_finished",
    reply: "r-watch-list",
    text: "Three are open; two wait on your review.",
  });
  here.ask(watcher, "w-gh", "shell", {
    command: "gh pr review 2107 --comment --body-file review.md",
  });

  const daily = here.addAgent({ id: "daily", name: "Daily", task: "Send me a lesson each day." });
  here.reply(daily, "Today's lesson is in.");
  here.card(daily, "q-eight", [
    { prompt: "Send tomorrow's lesson at 8:00 AM too?", kind: "confirm" },
  ]);
}
