# Terminal emulator cases

Behaviour cases for ace's native terminal emulators: input text and the screen it must leave.
They are data so every emulator runs the same set. The iOS emulator (`apps/ios/Sources/Terminal`)
runs them in `apps/ios/Tests/TerminalCaseTests.swift`; an Android one should run them as they are.

Each file holds `{ "cases": [Case] }`. A case:

| field | meaning |
| --- | --- |
| `name` | The behaviour, in words. |
| `columns`, `rows`, `scrollback` | The screen's size and how many history rows it keeps. |
| `steps` | In order: `{ "feed": text }` parses the text as output (one chunk; a sequence may span chunks), `{ "resize": [columns, rows] }` resizes. |
| `expect` | What must hold afterwards; every field is optional. |

`expect` fields:

| field | meaning |
| --- | --- |
| `lines` | Each screen row's text, trailing blanks trimmed; a wide character counts once, combining marks follow their character. |
| `cursor` | `[row, column]`, 0-based, on the screen. |
| `history` | Rows kept above the screen. |
| `text` | History then screen, rows joined by `\n`, trailing empty rows dropped. |
| `alternate` | The alternate (full-screen) buffer is showing. |
| `replies` | What the screen asked to send back (device reports), concatenated. |
| `title`, `titleLength` | The window title, or its length in scalars. |
| `modes` | Any of `applicationCursor`, `bracketedPaste`, `cursorVisible`. |
| `wrapped` | Screen rows that soft-wrapped into the next. |
| `cells` | Cells to check: `row`, `column`, and any of `char`, `fg`, `bg`, `flags`. Colours are `default`, `idx:N` (0–255) or `rgb:R,G,B`; `flags` is the exact set of `bold`, `faint`, `italic`, `underline`, `blink`, `inverse`, `invisible`, `strike`, `overline`, `wide`, `wideTrail`. |
| `linePrefix`, `lineSuffix` | Row (as a string key) to text its line starts or ends with. |
| `lineMaxScalars` | Row to the most Unicode scalars its text may hold. |

Control characters are written as JSON escapes (`\u001b` is ESC).
