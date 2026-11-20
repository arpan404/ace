import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeCard,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeCardChoices,
  spadeView,
} from "./index.ts";

const sha = "a".repeat(64);

/** A card in every block kind, as `spade_core::card` stores it. */
const fareDrop = {
  title: "Fare dropped: KTM to DEL",
  blocks: [
    { kind: "metric", label: "Fare", value: "182", unit: "USD", change: "-24" },
    { kind: "fields", rows: [{ label: "Dates", value: "12-19 Jan" }] },
    { kind: "progress", label: "Trips checked", value: 3, max: 5 },
    { kind: "table", columns: ["Carrier", "Fare"], rows: [["Buddha Air", "182"]] },
    { kind: "list", items: ["Morning flight"], ordered: true },
    {
      kind: "image",
      file: "charts/fares.png",
      image: { sha256: sha, media_type: "image/png", bytes: 10 },
      alt: "Fares",
    },
    { kind: "link", url: "https://fares.example.com/x", host: "fares.example.com" },
    {
      kind: "actions",
      actions: [
        { kind: "choose", id: "keep", label: "Keep watching" },
        {
          kind: "open",
          label: "See it",
          url: "https://fares.example.com/x",
          host: "fares.example.com",
        },
      ],
    },
  ],
};

describe("a card's data", () => {
  test("every block kind reads as the kind Spade stored", () => {
    const card = parseSpadeCard(fareDrop);
    expect(card?.title).toBe("Fare dropped: KTM to DEL");
    expect(card?.blocks.map((block) => block.kind)).toEqual([
      "metric",
      "fields",
      "progress",
      "table",
      "list",
      "image",
      "link",
      "actions",
    ]);
    expect(card?.blocks[5]).toEqual({
      kind: "image",
      alt: "Fares",
      image: { sha256: sha, mediaType: "image/png", bytes: 10 },
    });
    expect(card && spadeCardChoices(card)).toEqual([{ id: "keep", label: "Keep watching" }]);
  });

  test("a block a later Spade draws is kept as it came and the rest still reads", () => {
    const later = { kind: "chart", series: [1, 2, 3] };
    const card = parseSpadeCard({
      title: "Fares",
      blocks: [later, { kind: "list", items: ["One"] }],
    });
    expect(card?.blocks).toEqual([
      { kind: "unknown", raw: later },
      { kind: "list", items: ["One"], ordered: false },
    ]);
  });

  test("a link or an open action that isn't https is no link, and a bad action leaves the others", () => {
    const card = parseSpadeCard({
      title: "Links",
      blocks: [
        { kind: "link", url: "javascript:alert(1)", host: "x" },
        {
          kind: "actions",
          actions: [
            {
              kind: "open",
              label: "Go",
              url: "http://plain.example.com",
              host: "plain.example.com",
            },
            { kind: "run", label: "Do it" },
            { kind: "choose", id: "ok", label: "OK" },
          ],
        },
      ],
    });
    expect(card?.blocks[0]?.kind).toBe("unknown");
    expect(card?.blocks[1]).toEqual({
      kind: "actions",
      actions: [{ kind: "choose", id: "ok", label: "OK" }],
    });
  });

  test("a card with no title isn't drawn at all", () => {
    expect(parseSpadeCard({ title: " ", blocks: [] })).toBeUndefined();
    expect(parseSpadeCard("<div>")).toBeUndefined();
  });
});

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: 1000, event }));
    if (input) foldSpade(state, input);
  };
  const cards = () =>
    spadeBubbles(spadeView(state)).flatMap((bubble) => (bubble.kind === "card" ? [bubble] : []));
  const said = () =>
    spadeBubbles(spadeView(state)).flatMap((bubble) =>
      bubble.kind === "card"
        ? [`card ${bubble.card.title}`]
        : bubble.kind === "bot" || bubble.kind === "person"
          ? [`${bubble.kind}: ${bubble.text}`]
          : [],
    );
  return { stored, cards, said };
}

const shown = (version: number, title: string) => ({
  type: "card_shown",
  reply: "r1",
  call_id: `s${version}`,
  card: "card_1",
  version,
  data: { ...fareDrop, title },
});

describe("cards in the chat", () => {
  test("a card is its own row where it was shown, between the reply's words", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Watch KTM to DEL" });
    c.stored({ type: "reply_started", reply: "r1" });
    c.stored({
      type: "step_finished",
      reply: "r1",
      text: "Checking.",
      calls: [{ id: "s1", name: "card_show" }],
    });
    c.stored(shown(1, "Fare dropped"));
    c.stored({ type: "step_finished", reply: "r1", text: "That's the drop.", calls: [] });
    c.stored({ type: "reply_finished", reply: "r1", text: "That's the drop." });
    expect(c.said()).toEqual([
      "person: Watch KTM to DEL",
      "bot: Checking.",
      "card Fare dropped",
      "bot: That's the drop.",
    ]);
  });

  test("a later version updates the card in place and an older one never draws over it", () => {
    const c = conversation();
    c.stored(shown(1, "Fare 182"));
    c.stored({ type: "user_message", text: "Thanks" });
    c.stored(shown(3, "Fare 160"));
    c.stored(shown(2, "Fare 170"));
    expect(c.said()).toEqual(["card Fare 160", "person: Thanks"]);
    expect(c.cards()[0]?.version).toBe(3);
  });

  test("the person's choice shows on the version they chose on, once", () => {
    const c = conversation();
    c.stored(shown(1, "Fare 182"));
    c.stored({
      type: "card_action",
      card: "card_1",
      version: 1,
      action: "keep",
      label: "Keep watching",
    });
    expect(c.cards()[0]?.chosen).toEqual({ action: "keep", label: "Keep watching" });
    c.stored({ type: "card_action", card: "card_1", version: 1, action: "stop", label: "Stop" });
    expect(c.cards()[0]?.chosen?.action).toBe("keep");
    // A new version opens its choices again; a choice stored for an old one doesn't land on it.
    c.stored(shown(2, "Fare 170"));
    expect(c.cards()[0]?.chosen).toBeUndefined();
    c.stored({
      type: "card_action",
      card: "card_1",
      version: 1,
      action: "keep",
      label: "Keep watching",
    });
    expect(c.cards()[0]?.chosen).toBeUndefined();
  });
});
