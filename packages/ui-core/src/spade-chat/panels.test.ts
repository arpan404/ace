import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeCard,
  parseSpadeLiveFrame,
  readSpadePanels,
  spadeBubbles,
  spadePanelState,
  spadeQuietLine,
  spadeView,
} from "./index.ts";

/*
 * A packaged bot's panels in every client's fold (ADR 0200 §5.2): the latest state the bot set
 * follows the conversation live, the person's press shows where they pressed it, and a card's
 * `open` names a panel. Read leniently, as Spade writes them (`spade_core::panel`).
 */

function conversation() {
  const state = emptySpadeConversation();
  let seq = 0;
  const stored = (event: Record<string, unknown>) => {
    const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq: ++seq, at: 1000, event }));
    if (input) foldSpade(state, input);
  };
  return { stored, view: () => spadeView(state) };
}

const sha = "b".repeat(64);
const listed = readSpadePanels({
  panels: [
    { id: "watchlist", title: "Watched trips", page: sha, actions: ["stop_watching"], state: null },
    { id: "broken", title: 7 },
    "not a panel",
  ],
});

describe("a bot's panels", () => {
  test("are listed with the page each shows, leaving out what doesn't read", () => {
    expect(listed).toEqual([
      {
        id: "watchlist",
        title: "Watched trips",
        page: sha,
        actions: ["stop_watching"],
        state: null,
      },
      { id: "broken", title: "broken", page: undefined, actions: [], state: undefined },
    ]);
    expect(readSpadePanels("nope")).toEqual([]);
  });

  test("show the latest state the bot set, live from its conversation", () => {
    const c = conversation();
    const [panel] = listed;
    if (!panel) throw new Error("no panel");
    expect(spadePanelState(panel, c.view().panels)).toBeNull();
    c.stored({ type: "panel_updated", surface: "watchlist", call_id: "p1", data: { n: 1 } });
    c.stored({ type: "panel_updated", surface: "watchlist", call_id: "p2", data: { n: 2 } });
    expect(spadePanelState(panel, c.view().panels)).toEqual({ n: 2 });
  });

  test("say where the person pressed an action, in the conversation", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Watch KTM to DEL" });
    c.stored({
      type: "panel_action",
      surface: "watchlist",
      key: "a1",
      action: "stop_watching",
      label: "Stop watching",
      value: "KTM-DEL",
    });
    const quiet = spadeBubbles(c.view()).flatMap((bubble) =>
      bubble.kind === "quiet" ? [spadeQuietLine(bubble.quiet).label] : [],
    );
    expect(quiet).toEqual(["You pressed Stop watching"]);
  });

  test("open from a card's action that names one", () => {
    const card = parseSpadeCard({
      title: "Fares",
      blocks: [
        {
          kind: "actions",
          actions: [{ kind: "open_panel", label: "See all trips", panel: "watchlist" }],
        },
      ],
    });
    expect(card?.blocks[0]).toEqual({
      kind: "actions",
      actions: [{ kind: "open_panel", label: "See all trips", panel: "watchlist" }],
    });
  });
});
