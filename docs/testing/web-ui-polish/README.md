# Web UI polish verification

This work implements #428, #429 and #431 and a scoped portion of #412. It uses ace's existing theme, semantic token, native permission and checkout decision owners. No reference implementation was copied.

## Motion inventory

| Owner / consumers                                      | Default after this change                      | Reason                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `motion.css` progress sweep                            | Static progress segment                        | Indeterminate work is identified without continuous drawing. Determinate values still update from data. |
| Waiting ring                                           | Removed decorative second ring                 | The status glyph and label retain waiting/approval information.                                         |
| Working pulse / sidebar status                         | Static glyph and text                          | Whole-tree state, attention colors and counters still come from existing state owners.                  |
| Skeleton pulse                                         | Static skeleton shape                          | Loading layout and labels remain available.                                                             |
| `index.css` spinner / composer, transcript, loading    | Static dotted glyph                            | Status text and Stop/answer controls are unchanged.                                                     |
| Streaming caret / Tailwind pulse, spin, ping consumers | Static marker through unlayered central policy | Actual deltas continue to update content. Native input caret blinking is browser behavior.              |
| Reasoning slider convergence / glow / streams / mark   | Decorative overlay removed                     | The setting's value and interaction remain; no idle animation is needed.                                |
| Entrance, exit, panel and change transitions           | Bounded at existing motion tokens (140–320 ms) | They communicate actual changes; reduced motion still disables them.                                    |

No continuous CSS animation is intentionally retained. The existing UI-value guard rejects infinite declarations in central app CSS. Features consume the policy instead of owning replacement loops.

## Evidence and limits

`reported-diagnosis.json` preserves a sanitized subset of the original #431 diagnosis. It records that diagnosis's source and snapshot hash and contains no raw URLs, request content or provider data.

`baseline-motion.json` records this workstream's optimized fake-build observations before the policy change. On the running fixture, spinner-only pausing left two other loops and 869 DrawFrame events; pausing all CSS animations left zero loops and two events over approximately 15 seconds. Removing blur after pausing animations did not establish an additional drawing improvement (17 events); transient restyling and concurrent machine load make small counts unsuitable for strong comparisons. These are baseline isolation experiments, **not final-build measurements**. The hidden trial remained visible and is explicitly excluded.

The orchestrator stopped all local tests, browser/performance suites and builds because 25 agents were overloading the machine. Final optimized-build matched running/waiting/settled, visible/hidden and material traces and after screenshots therefore remain unverified. No battery-consumption or physical GPU claim is made. CI/reviewer verification must complete these acceptance items.

An opt-in, fake-only observer is provided at `tools/web-perf/src/steady-motion.ts` for a prepared optimized fake-build origin. It is not part of the normal gate and never launches a provider or daemon. It records fixture, visibility, observation duration, active loops, sanitized trace events and counts. A hidden trial is valid only if visibility is actually hidden. Compare identical viewport, theme, density and fixture state; keep caret focus and real data updates separate.

## Behavior coverage written for CI

- Permission presentation keeps native IDs/risk/enforcement, uses Full access only for verified unrestricted modes, and explicitly displays unavailable saved choices.
- Work details preserve checkout commands, primary next action, full context, nested agent/background attention, root-agent pending state, dismissal focus and scroll/draft persistence.
- Copy preserves multiline visible text and mention names while excluding injected provider text.
- Search keeps active scope visible when filters close and Clear restores all kinds.
- Structured prompt edits preserve unknown YAML/comments; cancellation and route navigation protect unsaved drafts.
- Skills filtering/disclosure reveals only the chosen groups, and source can be read as Markdown or inspected raw.
- Browser checks cover real theme/custom preview colors, selected/keyboard states, actual density geometry, phone/tablet/desktop bounds, unobscured question controls, static status loops, and screenshots for owner review.

Per the latest orchestrator instruction, tests were written but not run locally after the override. CI must run full typecheck, behavioral tests, dependency/UI/size/protocol guards, browser checks and the remaining performance verification. Local final verification is limited to formatting, lint and sequential typechecks of changed workspace packages.

## Local command results

Formatting completed before the final small diagnostic corrections. Lint reported a shadowed preview parameter and a hook dependency; both were corrected without repeating the root command. Sequential typechecks passed for `@ace/protocol`, `@ace/provider-kit`, `@ace/ui-core`, `@ace/adapter-acp`, `@ace/adapter-codex`, `@ace/models`, `@ace/commands` and `@ace/web-e2e`. Web typecheck found test-fixture typing errors, and web-perf found two Playwright API typing errors; those diagnostics were corrected without rerunning those packages. These results are not a claim that the final full gate passed. CI must verify the final source.

## #412 scope retained for parallel owners

Composer strips, Send/composer geometry (including #487), New-thread/history project integration, inline commenting/diff review, browser annotations, shell navigation/panels/toolbars/launcher and Devices prerequisites remain with their respective parallel workstreams. Sidebar metadata simplification remains a follow-up beyond this PR's status visibility and hover placement fixes. #412 remains open.
