import { fakeAskApp, type FakeSpadeApi } from "@ace/fake-daemon";

/*
 * `?fakeWorld=spade`, a connected app (ADR 0202, amendment 5): Quill has Notion, whose server
 * annotates nothing. "See what you can see in my notion" ran its three reads with no card; then
 * Quill asked to make three pages at once, after reading untrusted pages, so they wait on one
 * card with Always allow for Notion. For checking both by eye in both schemes.
 */
export function seedFakeNotion(here: FakeSpadeApi) {
  if (!here.connectors.connectors.some((each) => each.id === "notion"))
    here.connectors.connectors.push({
      id: "notion",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      catalogue: "notion",
      sign_in: "oauth",
      state: "connected",
      account: "sam@acme.dev",
      tools: 12,
      last_used_ms: Date.now() - 20 * 60_000,
    });
  const quill = here.addAgent({
    id: "quill",
    name: "Quill",
    task: "Keep my Notion notes tidy and find things in them.",
    avatar: {
      kind: "character",
      v: 1,
      body: "round",
      pair: "ocean",
      ears: "none",
      marking: "none",
      eyes: "round",
      mouth: "smile",
      cheeks: "none",
      accessory: "none",
    },
  });
  here.connectors.access.set("quill", { all: false, connectors: ["notion"] });
  const store = (event: Record<string, unknown>) => here.store(quill.conversation, event);
  store({ type: "user_message", text: "see what you can see in my notion" });
  store({ type: "reply_started", reply: "r-quill-1" });
  const reads = [
    ["q1", "notion__list_shared_pages", "12 pages shared with Quill."],
    ["q2", "notion__list_favorite_pages", "4 favorite pages."],
    ["q3", "notion__list_recent_pages", "8 recent pages."],
  ] as const;
  store({
    type: "step_finished",
    reply: "r-quill-1",
    text: "",
    calls: reads.map(([id, name]) => ({ id, name, arguments: { limit: 100 } })),
  });
  for (const [id, name, content] of reads) {
    store({ type: "tool_started", reply: "r-quill-1", call_id: id, name });
    store({ type: "tool_finished", reply: "r-quill-1", call_id: id, name, content });
  }
  const seen =
    "I can see 12 pages shared with me, 4 favorites and 8 recent ones. The trip notes from last week are three loose pages.";
  store({ type: "step_finished", reply: "r-quill-1", text: seen });
  store({ type: "reply_finished", reply: "r-quill-1", text: seen });
  store({ type: "user_message", text: "make a page for each trip note" });
  fakeAskApp(
    here,
    quill,
    "notion",
    ["Lisbon", "Porto", "Sintra"].map((title, at) => ({
      callId: `q${at + 4}`,
      name: "notion__create_page",
      args: { title: `${title} trip`, parent: { page_id: "Trips" } },
      reason:
        "It may change something in the app, and the bot has read untrusted content, so you decide.",
    })),
  );
}
