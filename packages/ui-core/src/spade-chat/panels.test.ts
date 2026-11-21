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
 * follows the conversation live, an action shows where it came in, as the page's or the person's
 * confirm, and a card's `open` names a panel. Read leniently, as Spade writes them (`spade_core::panel`).
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
    {
      id: "watchlist",
      title: "Watched trips",
      page: sha,
      actions: ["stop_watching", "book_fare"],
      confirm: [{ name: "book_fare", label: "Book this fare" }],
      state: null,
    },
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
        actions: ["stop_watching", "book_fare"],
        confirm: [{ name: "book_fare", label: "Book this fare" }],
        state: null,
        app: undefined,
      },
      {
        id: "broken",
        title: "broken",
        page: undefined,
        actions: [],
        confirm: [],
        state: undefined,
        app: undefined,
      },
    ]);
    expect(readSpadePanels("nope")).toEqual([]);
  });

  test("an MCP app's page lists with its app, and one refused for the network has no page", () => {
    const [drawn, refused] = readSpadePanels({
      panels: [
        {
          id: "app.fake.0123456789ab",
          title: "Fake",
          page: sha,
          actions: ["tools/call", "ui/message", "ui/update-model-context"],
          confirm: [],
          state: { input: {}, result: { content: [] } },
          app: {
            name: "Fake",
            tool: "show_board",
            refused: null,
            tools: [{ name: "move_card", model: false, app: true }],
            withheld: ["the camera"],
          },
        },
        {
          id: "app.fake.ba9876543210",
          title: "Fake",
          page: null,
          app: { name: "Fake", tool: "show_map", refused: "This app's page needs the network." },
        },
      ],
    });
    expect(drawn?.app).toEqual({
      name: "Fake",
      tool: "show_board",
      refused: undefined,
      tools: [{ name: "move_card", app: true }],
      withheld: ["the camera"],
    });
    expect(refused?.page).toBeUndefined();
    expect(refused?.app?.refused).toBe("This app's page needs the network.");
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

  test("say where an action came in, the page's or the person's confirm", () => {
    const c = conversation();
    c.stored({ type: "user_message", text: "Watch KTM to DEL" });
    c.stored({
      type: "panel_action",
      surface: "watchlist",
      key: "a1",
      action: "stop_watching",
      label: "Stop watching",
      value: "KTM-DEL",
      by: "page",
    });
    c.stored({
      type: "panel_action",
      surface: "watchlist",
      key: "a2",
      action: "book_fare",
      label: "Book this fare",
      value: "KTM-DEL",
      by: "person",
    });
    // One stored before the sender was kept is the page's.
    c.stored({
      type: "panel_action",
      surface: "watchlist",
      key: "a3",
      action: "check_now",
      label: "Check now",
    });
    const quiet = spadeBubbles(c.view()).flatMap((bubble) =>
      bubble.kind === "quiet" ? [spadeQuietLine(bubble.quiet).label] : [],
    );
    expect(quiet).toEqual([
      "The panel sent Stop watching",
      "You confirmed Book this fare",
      "The panel sent Check now",
    ]);
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
