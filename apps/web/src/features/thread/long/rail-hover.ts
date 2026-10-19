/**
 * When the rail shows a turn's preview card, with hover intent: the pointer has to rest on a tick
 * before a card opens, so sweeping across the rail flashes nothing; once a card is open it follows
 * the pointer from tick to tick at once; and it outlives a brief slip off the rail.
 * Pure: each step returns the next state and, at most, one timer to start. Starting it replaces
 * whatever timer the previous step asked for, and when it runs out it sends its `fire` event.
 */

/** How long, in milliseconds, the pointer rests on a tick before its card opens. */
export const restMs = 140;
/** How long, in milliseconds, an open card waits after the pointer leaves before it closes. */
export const graceMs = 100;

export interface RailHover {
  /** The tick under the pointer. */
  readonly hovered?: number | undefined;
  /** The tick whose card is open. */
  readonly shown?: number | undefined;
}

export type RailHoverEvent =
  /** The pointer moved onto a tick. */
  | { readonly type: "enter"; readonly index: number }
  /** The pointer left the rail. */
  | { readonly type: "leave" }
  /** Keyboard focus landed on a tick: its card opens straight away. */
  | { readonly type: "focus"; readonly index: number }
  /** Escape, a click, or focus leaving the rail: the card closes now. */
  | { readonly type: "dismiss" }
  /** A timer the previous step started has run out. */
  | { readonly type: "rested" }
  | { readonly type: "graced" };

export interface RailHoverStep {
  readonly state: RailHover;
  readonly wait?: { readonly ms: number; readonly fire: RailHoverEvent };
}

export const restingHover: RailHover = {};

export function stepRailHover(state: RailHover, event: RailHoverEvent): RailHoverStep {
  switch (event.type) {
    case "enter":
      // With a card open, the next tick's replaces it at once; otherwise the pointer must rest.
      if (state.shown !== undefined) return { state: { hovered: event.index, shown: event.index } };
      return {
        state: { hovered: event.index },
        wait: { ms: restMs, fire: { type: "rested" } },
      };
    case "rested":
      return { state: { ...state, shown: state.hovered } };
    case "leave":
      if (state.shown === undefined) return { state: {} };
      return { state: { shown: state.shown }, wait: { ms: graceMs, fire: { type: "graced" } } };
    case "graced":
      return { state: { hovered: state.hovered } };
    case "focus":
      return { state: { ...state, shown: event.index } };
    case "dismiss":
      return { state: { hovered: state.hovered } };
  }
}
