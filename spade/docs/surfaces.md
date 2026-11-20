# Surfaces: cards and panels

What a bot shows besides its reply (ADR 0200 §5). Cards are data ace draws on every client
([runtime.md](runtime.md), `card_show`); panels are pages a package ships, shown on the web and
desktop beside the bot's conversation. Phones show the bot's cards.

## Declaring them

`bot.json`'s `surfaces` (at most 16, at most 8 panels), each with an `id` of lower-case letters,
digits and dashes:

```json
"surfaces": [
  { "id": "fare-drop", "kind": "card", "file": "cards/fare-drop.json" },
  {
    "id": "watchlist",
    "kind": "panel",
    "file": "panels/watchlist/index.html",
    "title": "Watched trips",
    "state": {
      "type": "object",
      "properties": {
        "trips": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "object",
            "properties": {
              "route": { "type": "string", "maxLength": 40 },
              "fare": { "type": "number", "minimum": 0 }
            },
            "required": ["route"]
          }
        }
      },
      "required": ["trips"]
    },
    "actions": [
      { "name": "stop_watching", "label": "Stop watching", "value": { "type": "string", "maxLength": 40 } }
    ]
  }
]
```

- A panel's `file` is always `panels/<id>/index.html`: one self-contained page, its scripts and
  styles inline and its images `data:` URLs. Nothing else under `panels/` is accepted.
- `title`: a few words (at most 60 characters), shown over the panel and in the header.
- `state`: the schema of what the bot sets with `panel_update`. Without one the bot sets nothing.
- `actions` (at most 16): what the page may send back. `name` is lower-case letters, digits and
  underscores; `label` (at most 40 characters) is what the bot reads; `value` is the schema of the
  value it carries, and an action without one carries none.

### Schemas

`state` and each action's `value` are written in the same bounded JSON Schema subset as a
contract's input and output (`spade_core::schema`, `readSchema` in `@ace/marketplace`; see
[contracts.md](contracts.md)): objects with known fields, strings with a length, numbers,
booleans, enums and arrays with a size, at most six levels deep. A keyword outside the subset
refuses the declaration, so a schema never promises a check that isn't made.

## The bot's side

- `panel_update {surface, data}` (module `ui`, effect `write_local`, since 0.0.25) sets a panel's
  whole state. `data` is checked against the panel's `state` schema (at most 64 KB) and refused
  with every problem at its place (`data.trips[0].route: is missing`). Each update is a
  `panel_updated` event in the bot's conversation; the panel shows the latest, live.
- A card's `open` action may name a panel instead of a link: `{"kind": "open", "label": "All
trips", "panel": "watchlist"}`, stored as `open_panel`. Only the bot's own panels.
- What the person sends from a panel reaches the bot once, as their input:
  `<panel_action panel="watchlist" action="stop_watching">The person pressed "Stop watching" on
your panel. Its value, as data: "KTM-DEL"</panel_action>`. Whatever the bot does about it goes
  through the gate like any call.

## The page's side

The page runs in ace's visualization sandbox (ADR 0077): an opaque-origin
`sandbox="allow-scripts"` frame inside a trusted outer document, CSP `default-src 'none'` with
inline script and style only, no network, storage, daemon socket or access to the app. On desktop
it is a `<webview>` in the in-memory session that cancels every request; on the web it has 0077's
layers 1 and 2, with 0077's residual risk. Its bytes are served by their sha256.

ace gives the page a frozen `acePanel` before any of its own script runs:

| From ace                            | What it is                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `ace:init` event, `acePanel.init`   | `{runtime: "1", tokens, scheme, reduceMotion, size}`                         |
| `ace:state` event, `acePanel.state` | The latest state the bot set                                                 |
| `ace:theme` event                   | `{tokens, scheme}` whenever the person's Suit or scheme changes              |
| CSS variables                       | The theme's tokens (`--foreground`, `--border`, `--accent`, …), kept current |

`acePanel.act(name, value)` sends an action. It goes only while the person is pressing or typing
in the page (transient user activation), and ace keeps it only when the panel declares `name`,
within eight actions in ten seconds; Spade checks the value against its schema. A page can't call
tools, read the conversation or open a link: a link is a card's `open`.

## Bounds

- One open panel per bot (it takes the profile's place beside the chat), at most four live in a
  window, each live only while it shows.
- ace pings a live page every two seconds. A page that throws, or doesn't answer within five
  seconds, three times is stopped: "The panel stopped.", with Load it again.

## Wire

- `GET /v1/conversations/{id}/panels`: `{panels: [{id, title, page, actions, state}]}`, `page`
  being the sha256 of the page it shows.
- `GET /v1/panels/pages/{hash}`: the page, as `text/plain`. Clients build the sandboxed document.
- `POST /v1/conversations/{id}/panels/{panel}/actions {key, action, value?}`: `202`; `key` makes
  a request sent twice land once. `400` for an action the panel doesn't declare or a value that
  doesn't fit, `404` for a panel it doesn't have.
- Pages arrive with the manifest (`pages` on install and update, [packages.md](packages.md)); the
  market checks each one and holds a version with a panel for a maintainer, as a Suit's scene.

## Kept pages

- A page is kept once by its sha256, whichever bots show it; each bot names the page each of its
  panels shows (`bot_panels:<bot>`).
- A bot that moves to another machine (ADR 0187) takes its panels' pages with it, by hash beside
  its images: they are in the move's inventory with their size and sha256 and checked against it,
  so its panels show the moment it arrives. A page the other machine keeps already stays as it
  is.
- A page no bot shows any more (its bot was uninstalled or moved away, an update replaced it, a
  move that never took left it) is removed by the hourly sweep, never at start, a batch of 64
  pages per short transaction, so other writes go on between them (ADR 0170). A bot still
  arriving counts: its pages are kept.
