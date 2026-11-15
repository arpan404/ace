import type { Item } from "@ace/protocol";

/**
 * The person's own message: what they typed or queued. Everything ace or the provider wrote for
 * them is synthetic and never starts a turn on screen, including ace's Continue after a restart
 * or a usage limit ("Continue where you left off."): the turn it continues carries on, and the
 * input waits behind that turn's restart or limit row.
 */
export function isPersonMessage(item: Item | undefined): boolean {
  return item?.type === "message" && item.role === "user" && !item.synthetic;
}
