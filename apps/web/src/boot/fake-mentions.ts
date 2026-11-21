import { facts, ScenarioPlayer, type FakeDaemon, type FakeSpadeApi } from "@ace/fake-daemon";
import { CommandId, SpadeFaceJson } from "@ace/protocol";

/*
 * `?fakeWorld=mentions`: the Spade world plus a thread where the person asked Flights and the
 * Lisbon trip club, and named a device, with the bots' replies under their message; and Flights'
 * chat showing where the ask came from (ADR 0198), for checking the picker, chips and replies
 * by eye. The build server's Spade bots and its emulator are in the picker too, and a second thread
 * waits on the person because the bot it asked does (the Inbox).
 */
export function seedFakeMentions(daemon: FakeDaemon, here: FakeSpadeApi, server: FakeDaemon) {
  server.appDevices.addDevice({
    id: "android:Pixel_9_Pro_API_36",
    platform: "android",
    name: "Pixel 9 Pro",
    state: "booted",
    runtime: "Android 16",
  });
  seedWaitingAsk(daemon, here);
  const threadId = "thread-mentions";
  const flights = here.agents.find((agent) => agent.id === "flights");
  const inbox = here.agents.find((agent) => agent.id === "inbox");
  const about = CommandId.parse("send-mentions-1");
  // A face as Spade stores it, read as the wire would carry it.
  const face = (agent: typeof flights) => {
    const parsed = SpadeFaceJson.safeParse(agent?.avatar);
    return parsed.success ? parsed.data : undefined;
  };
  new ScenarioPlayer(
    daemon,
    {
      thread: {
        id: threadId,
        workspaceId: "ace",
        title: "Fix the login redirect",
        provider: "codex",
      },
      steps: [
        {
          kind: "facts",
          label: "asked",
          agoMs: 4 * 60_000,
          facts: [
            facts.rootAgent("codex"),
            facts.turn("root"),
            {
              type: "item.upsert",
              agent: "root",
              item: "person-1",
              draft: {
                type: "message",
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: "@Flights and @Lisbon trip, check what the redirect breaks for bookings, then try it on @Build server",
                  },
                ],
                origin: { kind: "person", commandId: about },
                complete: true,
              },
            },
            {
              type: "item.upsert",
              agent: "root",
              item: "ace-asked:m1",
              draft: {
                type: "notice",
                level: "info",
                text: "Asked Flights and Lisbon trip",
                asked: {
                  about,
                  to: [
                    {
                      to: { kind: "bot", id: "flights", name: "Flights", avatar: face(flights) },
                      state: "answered",
                    },
                    {
                      to: {
                        kind: "club",
                        id: "lisbon",
                        name: "Lisbon trip",
                        faces: [
                          { id: "flights", avatar: face(flights) },
                          { id: "inbox", avatar: face(inbox) },
                        ],
                      },
                      state: "answering",
                      detail: "Inbox is reading the booking emails",
                    },
                  ],
                  devices: [
                    {
                      type: "device",
                      id: "build-server",
                      name: "Build server",
                      kind: "server",
                      machine: { id: "build-server", name: "Build server", here: false },
                      os: "Linux",
                      online: true,
                    },
                  ],
                  share: "thread",
                  shares: [
                    "this message",
                    "the thread's title and project",
                    "branch fix-login-redirect",
                    "its last 3 turns",
                  ],
                },
                complete: true,
              },
            },
            facts.message(
              "root",
              "answer-1",
              "assistant",
              "The redirect drops the `next` parameter after sign-in. I've kept it through the OAuth round trip and added a test.",
            ),
            facts.endTurn("root"),
            {
              type: "item.upsert",
              agent: "root",
              item: "ace-reply:m1:0",
              draft: {
                type: "message",
                role: "assistant",
                parts: [
                  {
                    type: "text",
                    text: "Bookings land on `/trips/new?next=…`. Without `next` people end up on the home page and lose the fare they picked. Your fix covers it.",
                  },
                ],
                speaker: {
                  kind: "bot",
                  id: "flights",
                  name: "Flights",
                  avatar: face(flights),
                  about,
                },
                complete: true,
              },
            },
            {
              type: "item.upsert",
              agent: "root",
              item: "ace-reply:m2:0",
              draft: {
                type: "message",
                role: "assistant",
                parts: [
                  {
                    type: "text",
                    text: "Two booking confirmations from this week point at the same broken link. Checking the rest",
                  },
                ],
                speaker: {
                  kind: "bot",
                  id: "inbox",
                  name: "Inbox",
                  avatar: face(inbox),
                  club: { id: "lisbon", name: "Lisbon trip" },
                  about,
                },
                complete: false,
              },
            },
          ],
        },
      ],
    },
    { agoMs: 0 },
  ).runUntilBlocked();
  // Flights' own chat: the ask, from the thread, and its answer.
  if (flights) {
    here.store(flights.conversation, {
      type: "user_message",
      text: "@Flights and @Lisbon trip, check what the redirect breaks for bookings",
      from_thread: { id: threadId, title: "Fix the login redirect", untrusted: true },
    });
    here.reply(
      flights,
      "Bookings land on `/trips/new?next=…`. Without `next` people end up on the home page and lose the fare they picked. Your fix covers it.",
    );
  }
}

/** A thread whose asked bot waits on the person in Spade: it needs them, so it is in the Inbox. */
function seedWaitingAsk(daemon: FakeDaemon, here: FakeSpadeApi) {
  const flights = here.agents.find((agent) => agent.id === "flights");
  const avatar = SpadeFaceJson.safeParse(flights?.avatar);
  const about = CommandId.parse("send-mentions-2");
  new ScenarioPlayer(
    daemon,
    {
      thread: {
        id: "thread-mentions-waiting",
        workspaceId: "ace",
        title: "Write the release notes",
        provider: "claude",
      },
      steps: [
        {
          kind: "facts",
          label: "waiting",
          agoMs: 2 * 60_000,
          facts: [
            facts.rootAgent("claude"),
            facts.turn("root"),
            {
              type: "item.upsert",
              agent: "root",
              item: "person-1",
              draft: {
                type: "message",
                role: "user",
                parts: [
                  { type: "text", text: "@Flights which fare changes should the notes mention?" },
                ],
                origin: { kind: "person", commandId: about },
                complete: true,
              },
            },
            facts.message(
              "root",
              "answer-1",
              "assistant",
              "Drafting the notes while Flights checks.",
            ),
            facts.endTurn("root"),
            {
              type: "background.started",
              owner: "ace",
              agent: "root",
              task: "ace-ask:w1",
              kind: "other",
              title: "Flights is answering",
              stoppable: true,
            },
            { type: "background.waiting", task: "ace-ask:w1", waiting: true },
            {
              type: "item.upsert",
              agent: "root",
              item: "ace-asked:w1",
              draft: {
                type: "notice",
                level: "info",
                text: "Asked Flights",
                asked: {
                  about,
                  to: [
                    {
                      to: {
                        kind: "bot",
                        id: "flights",
                        name: "Flights",
                        ...(avatar.success ? { avatar: avatar.data } : {}),
                      },
                      state: "waiting",
                      detail: "Flights needs you in Spade",
                    },
                  ],
                  devices: [],
                  share: "thread",
                  shares: ["this message", "the thread's title and project"],
                },
                complete: true,
              },
            },
          ],
        },
      ],
    },
    { agoMs: 0 },
  ).runUntilBlocked();
}
