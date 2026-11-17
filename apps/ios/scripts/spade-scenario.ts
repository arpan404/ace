import { FakeSpadeApi, type FakeDaemon } from "@ace/fake-daemon";

/*
 * Spade on the fixture's machine (ADR 0121, 0139): turned on in Settings › Beta and running,
 * with Spade itself, a bot waiting on an approval, one working and one that finished. `POST
 * /review/spade` stages the rest: `off` turns Beta's switch off (the tab goes), `on` back on,
 * `stream` has the finished bot start a reply and stream its first words. `on` also puts back
 * what earlier tests changed, so each starts from the seed whatever ran before it.
 */

export type SpadeScenario = "off" | "on" | "stream";

let api: FakeSpadeApi | undefined;
let asks = 0;
/** Builder's open reply: the one asking, then answered and still open. */
let asking = "r-builder-0";
const tests = { command: "bun run test:fast apps/ios/bridge" };

export function seedSpade(daemon: FakeDaemon, now: number): void {
  daemon.services.settings.seed({ "beta.spade": true, "spade.enabled": true });
  daemon.spade.status = { state: "ready", version: "0.6.0" };
  const spade = new FakeSpadeApi(daemon.spade, Date.now);
  api = spade;
  const minute = 60_000;
  const main = spade.addAgent({ id: "spade", name: "Spade", kind: "main", last_activity: now });
  spade.store(main.conversation, { type: "user_message", text: "What's on today?" });
  spade.reply(main, "Two reviews are waiting, and the release notes need a last read.");
  const builder = spade.addAgent({ id: "builder", name: "Builder", last_activity: now - minute });
  spade.store(builder.conversation, {
    type: "user_message",
    text: "Run the tests for the iOS bridge",
  });
  spade.ask(builder, "call-tests", "shell", tests, asking);
  spade.addAgent({
    id: "research",
    name: "Research",
    state: "working",
    status: "Reading the Swift concurrency notes",
    last_activity: now - 2 * minute,
  });
  const notes = spade.addAgent({ id: "notes", name: "Notes", last_activity: now - 30 * minute });
  spade.store(notes.conversation, { type: "user_message", text: "Summarise yesterday's PRs" });
  spade.reply(notes, "Three merged: the Work card fix, the market Worker and the Beta page.");
}

export function spadeScenario(daemon: FakeDaemon, scenario: SpadeScenario): void {
  if (scenario === "off" || scenario === "on") {
    daemon.services.settings.write("beta.spade", scenario === "on");
    // Back on, Spade runs again, as the daemon starts it.
    if (scenario === "on") {
      daemon.spade.setStatus({ state: "ready", version: "0.6.0" });
      reseed();
    }
    return;
  }
  const notes = api?.agents.find((agent) => agent.id === "notes");
  if (!api || !notes) return;
  api.store(notes.conversation, { type: "reply_started", reply: "r-live" });
  api.status(notes, "working", "Writing");
  daemon.spade.emit(`/v1/conversations/${notes.conversation}/live`, "delta", {
    reply: "r-live",
    text: "Looking at today's ",
  });
}

/** Builder asks again once answered, and Notes' streamed reply finishes. */
function reseed(): void {
  const builder = api?.agents.find((agent) => agent.id === "builder");
  const notes = api?.agents.find((agent) => agent.id === "notes");
  if (!api) return;
  if (builder && builder.state !== "waiting") {
    api.store(builder.conversation, { type: "reply_finished", reply: asking, text: "" });
    asking = `r-builder-${++asks}`;
    api.ask(builder, `call-tests-${asks}`, "shell", tests, asking);
  }
  if (notes && notes.state === "working") {
    api.store(notes.conversation, {
      type: "reply_finished",
      reply: "r-live",
      text: "Looking at today's ",
    });
    api.status(notes, "idle", null);
  }
}
