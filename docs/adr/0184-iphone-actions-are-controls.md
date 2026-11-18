# 0184: On the iPhone, actions are controls, not words

Date: 2026-11-17. Status: accepted. Decided by: the owner, after looking at the inner pages on a
phone. Amends the design language's "Inner pages and sheets" rule that actions are words.

## Context

The design language drew every inner-page action as a word in the action role
(`TextActionStyle`): the way forward in ink and semibold, the rest muted. The default theme's
accent is the body ink, and the Settings stack was tinted with it. A visual audit of the inner
pages on 2026-11-17 (84 screenshots, light, dark and the largest text size) found the result:

- "Sign in again", "Use by default", "Check again" and "Update now" drew exactly like the row
  titles beside them, with no colour, shape or chevron to say they act.
- The muted words ("Retry", "Continue", "Run checks") read as disabled.
- Each page drew its own error state, with Retry above or below the message, filled or bare, in
  different words.

The approval strip had already moved off words to real buttons (owner, 2026-11-16, #2165).

## Options considered

- **Keep words, give them the accent's hue.** Fixes "reads as a label" only where a theme has a
  hued accent; the default ink theme stays broken, and a word on its own still has no shape.
- **Real controls with a colour of their own (chosen).** What iOS 26 draws: Liquid Glass buttons
  for a page's actions, tinted text for actions that are list rows.

## Decision

1. **Actions are controls.** A page's one way forward is a prominent button (`.primaryAction`:
   `.glassProminent` on iOS 26, a filled capsule before it). Actions beside it are secondary
   buttons (`.secondaryAction`: `.glass`, a tinted capsule before it). An action that is a row of
   a list is a row action (`.rowAction`): its words in the action colour at the row's height,
   with the caret when it opens a page. The destructive role draws in the system red in all
   three. They live in `apps/ios/Sources/Views/Primitives/AceButtonStyles.swift`.
2. **Actions have their own colour.** `AceDesign.Ink.action` is the theme's accent when it has a
   hue, and the system blue when the accent is ink, so nothing tappable draws in the body ink.
   Stacks (Settings, Projects, Agents, Browser) are tinted with it. The send button, the selected
   tab and the person's bubble keep the one accent (`Ink.accent`) as before.
3. **One error row, one empty state, one add row.** `ProblemRow` is the only way a failed read or
   change shows: the sentence in the failed colour, at most a line of why, then its way out as a
   secondary button, in that order. `EmptyState` keeps its shape; its action is a prominent
   button, or a secondary one in its failed form. `AddRow` is the one "Add account" / "New
   automation" row.
4. **Inline words stay for inline actions.** `TextActionStyle` remains for an action inside a line
   of text, now in the action colour; it never draws muted.

The rest of the design language stands: cardless inner pages, one accent on the primary action,
words over icons on status strips.

## Consequences

- Tappable things read as tappable in every theme, including ink.
- The action colour is a second colour on screen besides the accent and status hues; it is
  reserved for what can be tapped.
- Pages still to be redesigned keep `TextActionStyle` call sites until their batch moves them onto
  these styles.

## Tests

`NativePaletteTests.actionsKeepAColouredAccentAndTurnSystemBlueWhenTheAccentIsInk` pins decision 2.
