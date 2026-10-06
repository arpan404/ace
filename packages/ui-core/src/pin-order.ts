/*
 * Places among pinned threads (`pinOrder`, higher first), as a drag or a keyboard move asks for
 * them. A move names new places for the moved threads only, between their new neighbours, so
 * one drop is one command per moved thread and two devices moving different threads never
 * undo each other. When no number fits between the neighbours (they were pinned before places
 * existed, or the gap has been halved to nothing), every pinned thread gets a fresh place.
 */

export interface PinnedPlace {
  id: string;
  /** The daemon's `pinOrder`; absent for pins from before places existed. */
  order: number | undefined;
}

export interface PinMove {
  id: string;
  order: number;
}

const placeOf = (pin: PinnedPlace): number => pin.order ?? 0;

/** Strictly descending, finite and inside the open interval (`low`, `high`). */
function fits(orders: readonly number[], low: number, high: number): boolean {
  return orders.every(
    (order, index) =>
      Number.isFinite(order) &&
      order > low &&
      order < high &&
      (index === 0 || order < (orders[index - 1] ?? Infinity)),
  );
}

/**
 * The places that put `moving` (top first) at `index` among the other pinned threads.
 * `pinned` is the Pinned group as shown, top first; it may include threads in `moving` (a move
 * within the group) or not (a pin by drag). Empty when nothing would change.
 */
export function placePinned(
  pinned: readonly PinnedPlace[],
  moving: readonly string[],
  index: number,
): PinMove[] {
  const movingSet = new Set(moving);
  const others = pinned.filter((pin) => !movingSet.has(pin.id));
  const at = Math.max(0, Math.min(index, others.length));
  const wanted = [
    ...others.slice(0, at).map((pin) => pin.id),
    ...moving,
    ...others.slice(at).map((pin) => pin.id),
  ];
  const allPinned = moving.every((id) => pinned.some((pin) => pin.id === id));
  if (allPinned && wanted.every((id, position) => pinned[position]?.id === id)) return [];
  const above = others[at - 1];
  const below = others[at];
  const count = moving.length;
  const high = above ? placeOf(above) : undefined;
  const low = below ? placeOf(below) : undefined;
  const orders = moving.map((_, step) => {
    if (high !== undefined && low !== undefined)
      return low + ((high - low) * (count - step)) / (count + 1);
    if (low !== undefined) return low + (count - step);
    if (high !== undefined) return high - (step + 1);
    return count - step;
  });
  if (fits(orders, low ?? -Infinity, high ?? Infinity))
    return moving.map((id, step) => ({ id, order: orders[step] ?? 0 }));
  return renumber(pinned, wanted);
}

/** Fresh, whole-number places for the whole group in `wanted` order, above every old place. */
function renumber(pinned: readonly PinnedPlace[], wanted: readonly string[]): PinMove[] {
  const top = Math.max(0, ...pinned.map(placeOf));
  const current = new Map(pinned.map((pin) => [pin.id, pin.order]));
  return wanted.flatMap((id, position) => {
    const order = top + wanted.length - position;
    return current.get(id) === order ? [] : [{ id, order }];
  });
}
