import type { FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, the transcript: Github watcher's chat across two days, for checking by eye
 * what a conversation draws. A time line after the night's gap and a routine's run named in its
 * line, a reply with code in its wells and its steps folded under it, inline code in both
 * bubbles, a heading, a list and a table, and a run of the person's messages. `rewind` moves the
 * fake's clock back by that many minutes for what is stored next.
 */
export function seedFakeTranscript(here: FakeSpadeApi, rewind: (minutes: number) => void) {
  const bot = here.addAgent({
    id: "github",
    name: "Github watcher",
    task: "Watch arpan404/ace and tell me what needs my review each weekday at 9.",
  });
  const c = bot.conversation;
  const say = (text: string) => here.store(c, { type: "user_message", text });
  const steps = (reply: string, calls: [string, string][]) => {
    here.store(c, {
      type: "step_finished",
      reply,
      text: "",
      calls: calls.map(([id, name]) => ({ id, name, arguments: {} })),
    });
    for (const [id, name] of calls)
      here.store(c, {
        type: "tool_finished",
        reply,
        call_id: id,
        name,
        content: "",
        is_error: false,
      });
  };
  rewind(60 * 10 + 29);
  say("see my ace repo");
  here.reply(
    bot,
    "I can't reach GitHub yet: `gh` isn't signed in and no GitHub app is connected. Which repo is it?",
  );
  rewind(60 * 10 + 27);
  say("arpan404/ace");
  say("it's public");
  here.reply(
    bot,
    "Got it. It's public, so I can read all 15 open pull requests. I'll check them each weekday at 9.",
  );
  rewind(42);
  here.store(c, {
    type: "user_message",
    text: "Check the pull requests that want a review.",
    from_routine: {
      id: "rt-gh",
      name: "Morning check",
      run: "run-gh",
      label: "9:00",
      heartbeat: false,
    },
  });
  here.store(c, { type: "reply_started", reply: "r-gh" });
  steps("r-gh", [
    ["g1", "shell"],
    ["g2", "shell"],
    ["g3", "workspace_read"],
    ["g4", "browser_open"],
  ]);
  const brief = [
    "## Two want your review",
    "",
    "**#2081** fails on Linux in one relay test:",
    "",
    "```log",
    "FAIL  packages/relay/src/noise.test.ts",
    "  ✕ handshake survives a dropped frame (5012 ms)",
    "    Timeout: no reply after 5000 ms",
    "```",
    "",
    "It passes on macOS, so it looks like the real timer. The test should use the fake clock:",
    "",
    "```ts",
    "- await sleep(5000);",
    "+ await clock.advance(5000);",
    "  expect(await peer.read()).toEqual(frame);",
    "```",
    "",
    "| PR | Waiting on | Checks |",
    "| --- | --- | --- |",
    "| #2081 | you | *1 failing* |",
    "| #2079 | you | passing |",
    "",
    "- I can post this as a review comment once I know how to sign in.",
    "- Nothing else changed overnight.",
  ].join("\n");
  here.store(c, { type: "step_finished", reply: "r-gh", text: brief });
  here.store(c, { type: "reply_finished", reply: "r-gh", text: brief });
  rewind(5);
  say("Use the `gh` login on this Mac.");
  here.reply(bot, "Done: I'm signed in as **arpan404** and posted the comment on #2081.");
  rewind(0);
  here.status(bot, "idle", null);
}
