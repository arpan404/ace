# suit.json

Every field a Suit's `suit.json` takes, with its range and default. Values outside a range are a `schema` problem. Keys not listed here are kept as raw data and ignored: they never reach the app.

## A complete example

```json
{
  "format": 1,
  "id": "brushed-steel",
  "name": "Brushed Steel",
  "description": "Graphite panels, machined edges, one amber pilot light.",
  "version": "1",
  "base": "midnight",
  "dark": {
    "canvas": "#16181B",
    "sidebar": "#111315",
    "surface": "#1C1F23",
    "raised": "#23272C",
    "hover": "#2A2E34",
    "active": "#32373E",
    "code": "#121417",
    "border": "#2C3036",
    "borderStrong": "#3D434B",
    "text": "#E8EAED",
    "muted": "#AEB4BC",
    "subtle": "#8E959E",
    "faint": "#6C737C",
    "accent": "#D9A441",
    "accentHover": "#E4B45A",
    "accentFg": "#16181B",
    "accentText": "#E8BC6A",
    "glass": null
  },
  "light": {
    "canvas": "#F3F4F5",
    "sidebar": "#E8EAEC",
    "surface": "#FFFFFF",
    "text": "#1A1C1F",
    "muted": "#4A5058",
    "subtle": "#5F666F",
    "accent": "#9A6A12",
    "accentFg": "#FFFFFF",
    "accentText": "#7E5508"
  },
  "fonts": {
    "ui": { "system": "\"SF Pro Text\", Inter, system-ui, sans-serif" },
    "mono": { "asset": "assets/fonts/plex-mono.woff2", "family": "Plex Mono" }
  },
  "shape": { "radius": 0.5, "border": 1, "density": "comfortable" },
  "motion": { "speed": 0.8 },
  "layout": { "messages": "flat", "toolRows": "detailed", "composer": "floating" },
  "labels": { "composer-placeholder": "Machine the next change…" },
  "ornaments": [{ "slot": "sidebar-footer", "asset": "assets/plate.svg" }],
  "regions": {
    "sidebar": { "background": "linear-gradient(180deg, #14161A, #0F1113)" }
  },
  "reveal": { "app": 0.4 },
  "terminal": { "fontFamily": "Plex Mono", "fontSize": 13, "cursorStyle": "bar" }
}
```

## Identity

| Field         | Takes                                                                                                                                                                                                                                                                  | Default |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `format`      | Always `1`.                                                                                                                                                                                                                                                            | none    |
| `id`          | Lower-case words joined by dashes, 1–48 characters, equal to the folder.                                                                                                                                                                                               | none    |
| `name`        | 1–60 characters, shown in Settings > Appearance.                                                                                                                                                                                                                       | none    |
| `description` | Up to 280 characters: one line on the look.                                                                                                                                                                                                                            | `""`    |
| `version`     | Up to 40 characters, display only.                                                                                                                                                                                                                                     | `"1"`   |
| `base`        | `ace`, `paper`, `midnight`, `grove`, `harbor` or `dusk`; fills unset fields.                                                                                                                                                                                           | `ace`   |
| `thumbnail`   | `{ "light": "assets/…", "dark": "assets/…" }`: a still of your backdrop per scheme for your card in Settings, a `.webp`, `.jpg` or `.png` of about 640 × 400. With a scene, capture its reduce-motion frame. Without one, the card shows a gradient from your palette. | none    |
| `scene`       | Set by ace from the folder; leave it out.                                                                                                                                                                                                                              | `false` |

## Colours

`light` and `dark` each take a palette; set at least one. A Suit with one scheme runs only in that scheme. Colours are `#RRGGBB`. Every field is optional and falls back to `base`, but a premium Suit sets the whole ramp in each scheme it has.

| Field               | What it colours                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `dark.canvas`       | The transcript and full pages: the main reading surface.                                       |
| `dark.sidebar`      | The sidebar, rail and side panel.                                                              |
| `dark.surface`      | Cards, bubbles, the composer.                                                                  |
| `dark.raised`       | Menus, popovers, dialogs.                                                                      |
| `dark.hover`        | A row or control under the pointer.                                                            |
| `dark.active`       | A pressed or selected row.                                                                     |
| `dark.code`         | Code blocks and inline code.                                                                   |
| `dark.border`       | Hairlines between areas.                                                                       |
| `dark.borderStrong` | Field outlines and stronger edges.                                                             |
| `dark.text`         | Body text and titles.                                                                          |
| `dark.muted`        | Secondary text: descriptions, metadata.                                                        |
| `dark.subtle`       | Tertiary text: timestamps, hints.                                                              |
| `dark.faint`        | Icons and decoration only, never words.                                                        |
| `dark.accent`       | Focus, selection, primary buttons, checked controls.                                           |
| `dark.accentHover`  | The accent under the pointer.                                                                  |
| `dark.accentFg`     | Labels on an accent fill.                                                                      |
| `dark.accentText`   | Links and accent-coloured words on the canvas.                                                 |
| `dark.diffAdd`      | Added lines' background.                                                                       |
| `dark.diffAddFg`    | Added lines' marker and text tint.                                                             |
| `dark.diffDel`      | Removed lines' background.                                                                     |
| `dark.diffDelFg`    | Removed lines' marker and text tint.                                                           |
| `dark.syntax.kw`    | Code keywords. Also `fn`, `str`, `num`, `type`, `com` (comments), `punc`.                      |
| `dark.glass`        | `{ "blur": 0–64, "saturate": 100–300 }` for frosted floating layers, or `null` for solid ones. |

`light` takes the same fields (`light.canvas`, `light.syntax.str`, …).

## Fonts

| Field         | Takes                                      |
| ------------- | ------------------------------------------ |
| `fonts.ui`    | The interface: sidebar, buttons, settings. |
| `fonts.prose` | Agents' answers and the person's messages. |
| `fonts.mono`  | Code, tool output and paths.               |

Each is `{ "system": "<family list>" }` (up to 200 characters) or `{ "asset": "assets/<file>", "family": "<name>" }` with a `.woff2`, `.woff`, `.ttf` or `.otf` file in `assets/`. No remote fonts.

## Shape and motion

| Field           | Takes                                                   | Default          |
| --------------- | ------------------------------------------------------- | ---------------- |
| `shape.radius`  | 0–2, multiplies every corner radius.                    | `1`              |
| `shape.border`  | 0.5–2, hairline weight in px.                           | `1`              |
| `shape.density` | `compact`, `comfortable` or `spacious`.                 | the device's own |
| `motion.speed`  | 0.5–2, multiplies ace's motion durations (2 is slower). | `1`              |

## Layout

| Field                    | Takes                                                            | Default   |
| ------------------------ | ---------------------------------------------------------------- | --------- |
| `layout.sidebar`         | `left` or `right`.                                               | `left`    |
| `layout.rail`            | `shown`, `hidden` or `merged` into the sidebar.                  | `shown`   |
| `layout.sidebarWidth`    | 200–480 px, a whole number.                                      | ace's     |
| `layout.transcriptWidth` | 560–1400 px, the reading column's max width.                     | ace's     |
| `layout.composer`        | `docked` or `floating`.                                          | `docked`  |
| `layout.header`          | `bar`, `minimal` or `hidden` (the title moves into the sidebar). | `bar`     |
| `layout.messages`        | `bubbles`, `flat` or `cards`.                                    | `bubbles` |
| `layout.toolRows`        | `compact`, `detailed` or `terminal`.                             | `compact` |

## Labels

`labels` replaces short words in fixed places, 1–40 characters each. Status words are never replaceable.

| Field                         | Replaces                         |
| ----------------------------- | -------------------------------- |
| `labels.composer-placeholder` | The message field's placeholder. |
| `labels.empty-transcript`     | A new thread's empty line.       |
| `labels.empty-sidebar`        | The empty thread list's line.    |
| `labels.working-word`         | The word in "Working for 1m".    |
| `labels.send`                 | The send button's label.         |

## Ornaments

`ornaments` is a list of up to 16 `{ "slot", "asset" }`; several may share a slot, shown in order.

| Field               | Takes                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ornaments[].slot`  | `sidebar-header`, `sidebar-footer`, `transcript-top`, `empty-state`, `composer-top`, `corner-top-left`, `corner-top-right`, `corner-bottom-left`, `corner-bottom-right`. |
| `ornaments[].asset` | `assets/<name>.svg` or `assets/<name>.html`, at most 64 KB.                                                                                                              |

Ornament files are rebuilt from an allowlist: SVG shapes, gradients, patterns, masks and filters; simple HTML text elements and `img`. Scripts, event handlers, `foreignObject`, SVG animation and links out are dropped and reported as `ornament` problems. They are inserted inline, so `fill="currentColor"` follows the scheme.

## Regions

Regions are `app`, `rail`, `sidebar`, `header`, `transcript`, `composer`, `right-panel` (the side panel) and `page` (full pages).

| Field                            | Takes                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `regions.sidebar.background`     | One CSS value (no `{`, `}` or `;`): a colour, gradients, `url(assets/…)` images. Same for every region.                                        |
| `regions.sidebar.border`         | One `border` value.                                                                                                                            |
| `regions.sidebar.shadow`         | One `box-shadow` value.                                                                                                                        |
| `regions.sidebar.backdropFilter` | One `backdrop-filter` value.                                                                                                                   |
| `reveal.app`                     | 0–1: how much of the scene or background behind a region shows through its surface. Same for every region.                                     |
| `scenes.app`                     | A `.js` file at the Suit's root that runs as that region's scene. Regions: `app`, `sidebar`, `header`, `composer`, `right-panel`, `page`.      |
| `scenes.celebration`             | A `.js` file that plays above the whole UI for a moment when the open thread's run finishes or a pull request merges (`references/scenes.md`). |

`regions` values are checked by suit.css's rules and become `--suit-<region>-background`, `-border`, `-shadow` and `-backdrop-filter`. A region's text must stay readable, so `reveal` is held under what the region's text allows over the scene; asking for more shows less. Without `reveal`, regions show: `app`, `rail`, `header` 0.65; `transcript`, `page` 0.3; `sidebar`, `composer`, `right-panel` 0 (solid). A `scene.js` at the root with no `scenes` means `{ "app": "scene.js" }`.

## Video

A Suit may play a video behind the app instead of an app scene (`scene.js` or `scenes.app`; region scenes still run). ace plays it in its own element: no Suit code runs for it.

| Field                  | Takes                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `video.sources`        | One to three `.mp4`, `.m4v`, `.mov` or `.webm` files in `assets/`: renditions of one video. ace plays the smallest that shows sharp.        |
| `video.poster`         | A `.webp`, `.jpg`, `.png` or `.avif` still in `assets/`: shown before the first frame, under Reduce motion, while saving power, on failure. |
| `video.fit`            | `cover` (default) or `contain`.                                                                                                             |
| `video.audio.muted`    | `true` or `false` (default): the Suit's own mute. ace has no sound control in its UI.                                                       |
| `video.audio.volume`   | 0–1, default 0.6: the loudest it plays.                                                                                                     |
| `video.palette.accent` | `true` (default) or `false`: the accent follows the picture's strongest colour, fitted so labels read and it never passes for a status.     |
| `video.palette.tint`   | 0–0.25, default 0.12: how much of that colour the veil over the video takes, less wherever text would read worse.                           |

```json
"video": {
  "sources": ["assets/clip-2160.mp4", "assets/clip-1080.mp4"],
  "poster": "assets/clip-still.webp",
  "audio": { "muted": false, "volume": 0.5 },
  "palette": { "accent": true, "tint": 0.12 }
}
```

- **Only media the person gives you.** Use a file they supplied or made themselves. Never download a video from a streaming site, record a stream, or work around a site's protections; if they only have a link, ask them for the file.
- **4K is what the file holds.** ace reads each file's real size and Settings shows it ("4K (3840 × 2160)" only for a 4K file). Don't upscale a video and call it 4K; ship a 1080p rendition beside a 4K one so smaller windows decode less.
- **A Suit made from someone's footage stays private.** Don't commit it to a repository, upload it or share it unless the person says the footage is theirs to share.
- The veil (`reveal.app`) and the palette checks keep text readable over any frame, so pick the palette for the picture's quiet moments and let the accent follow.

## Terminal

The terminal draws on a canvas, so CSS can't reach its text. Unset colours derive from the palette; ANSI colours are lifted until they read at 3:1, so pick hues, not exact contrast.

| Field                      | Takes                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.fontFamily`      | A bundled font's `family` from `fonts`, or a system stack.                                                                                |
| `terminal.fontSize`        | 9–24 px.                                                                                                                                  |
| `terminal.lineHeight`      | 1–2, times the size.                                                                                                                      |
| `terminal.letterSpacing`   | -1–4 px.                                                                                                                                  |
| `terminal.cursorStyle`     | `block`, `bar` or `underline`.                                                                                                            |
| `terminal.cursorBlink`     | `true` or `false`.                                                                                                                        |
| `terminal.reveal`          | 0–1: the side panel's background or scene behind the text.                                                                                |
| `terminal.dark.background` | `#RRGGBB` or `#RRGGBBAA`. Also `foreground`, `cursor`, `cursorAccent`, `selection`.                                                       |
| `terminal.dark.ansi.green` | One of the 16 ANSI colours: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and each `bright` form (`brightGreen`). |

`terminal.light` takes the same fields. A foreground under 4.5:1 on its background is a `contrast` problem at `terminal.<scheme>.foreground`.

## Folder limits

`suit.json` up to 64 KB, each scene up to 512 KB, `suit.css` up to 256 KB, everything else together up to 20 MB, at most 512 files and 8 folders deep. Videos don't count toward the 20 MB: each may be up to 8 GiB, three at most, and they are streamed, never read whole. Larger files are refused unread.
