import { line, circle, type Part } from "../parts.ts";
import { userCircle } from "./user-circle.ts";

/**
 * The person in a ring with a reviewer's verdict at its lower right, cut clear of the ring like
 * the "new" plus: `mark` is drawn around (18, 18).
 */
export function reviewed(mark: string): Part[] {
  const hole = circle(18, 18, 6.35);
  // The ring's parts are built fresh for this icon, so each takes the hole in place.
  return [...userCircle().map((part) => Object.assign(part, { hole })), line(mark)];
}
