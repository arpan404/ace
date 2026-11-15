import type { SuitPart, suitPartStates } from "@ace/protocol/suit-parts";

/** A `data-state` value from the Suit styling contract (ADR 0150). */
export type SuitPartState = (typeof suitPartStates)[number];

/** The attributes `part` returns, for a component that passes them on to its element. */
export type SuitPartProps = ReturnType<typeof part>;

/**
 * The attributes that name an element in the Suit styling contract (`suitParts`,
 * docs/design/suit-parts.md): `data-part`, and `data-state` / `data-variant` when given.
 * Attribute-only; nothing in ace's own CSS reads them.
 */
export function part(
  name: SuitPart,
  state?: SuitPartState | false | undefined,
  variant?: string | undefined,
): { "data-part": SuitPart; "data-state"?: SuitPartState; "data-variant"?: string } {
  return {
    "data-part": name,
    ...(state ? { "data-state": state } : {}),
    ...(variant ? { "data-variant": variant } : {}),
  };
}
