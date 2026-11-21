import type { FakeDaemon } from "@ace/fake-daemon";
import { running, template } from "./fake-spade.ts";

/*
 * `?fakeWorld=spade-empty`: Spade running with only itself, no bots and no clubs yet, and its
 * templates: the first visit, so the empty list and the new-bot start can be checked by eye.
 */
export function seedFakeSpadeEmpty(daemon: FakeDaemon) {
  const here = running(daemon);
  here.endpoints.push({
    id: "openrouter",
    name: "OpenRouter",
    format: "openai-chat",
    base_url: "https://openrouter.ai/api/v1/",
    header_names: [],
    session_header: null,
    needs_key: true,
    key_set: true,
    key_source: "keychain",
    models: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", source: "typed" }],
  });
  here.newBotModel = "openrouter/anthropic/claude-sonnet-5.5";
  here.addAgent({
    id: "spade",
    kind: "main",
    name: "Spade",
    avatar: { kind: "spade" },
    model: "openrouter/anthropic/claude-sonnet-5.5",
  });
  here.teams.templates.push(
    template("research", "Research", "Finds and checks sources.", {
      body: "round",
      pair: "lagoon",
      marking: "muzzle",
      mouth: "smile",
      cheeks: "blush",
      accessory: "glasses",
    }),
    template("travel", "Travel", "Plans trips and watches fares.", {
      body: "fox",
      pair: "ember",
      eyes: "almond",
      mouth: "smile",
      accessory: "scarf",
    }),
    template("writing", "Writing", "Drafts and edits with you.", {
      body: "cloud",
      pair: "lilac",
      eyes: "big",
      mouth: "smile",
      cheeks: "blush",
      accessory: "flower",
    }),
    template("inbox", "Inbox", "Sorts what came in and says what needs you.", {
      body: "square",
      pair: "sky",
      eyes: "round",
      mouth: "smile",
    }),
  );
}
