/** One item is larger than a whole page's byte budget, so no page can start with it. */
export class ItemPageCapacityExceeded extends Error {}
