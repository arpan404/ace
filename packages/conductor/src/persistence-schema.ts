import { z } from "zod";
import { Lane, Node, State } from "./schema.ts";

export const ArtifactRef = z.string().regex(/^[a-f0-9]{64}$/);
export const StoredLane = Lane.omit({ artifact: true }).extend({
  artifact: ArtifactRef.nullable(),
});
export const StoredNode = Node.omit({ completion: true, lastReview: true }).extend({
  completion: ArtifactRef.nullable(),
  lastReview: ArtifactRef.nullable(),
});
export const StoredRoot = z
  .object({
    ...State.shape,
    spec: ArtifactRef,
    plan: ArtifactRef.nullable(),
    storageVersion: z.literal(2),
  })
  .omit({ lanes: true, nodes: true });
export type StoredRoot = z.infer<typeof StoredRoot>;
export type StoredLane = z.infer<typeof StoredLane>;
export type StoredNode = z.infer<typeof StoredNode>;
export const Payload = z.object({ payload: z.string() });
export const Count = z.object({ n: z.number().int().nonnegative() });

/** Newly built pure state is trusted; external rows are parsed separately.
 * Freezing stops callers mutating the actor's admitted artifacts through load(). */
export function freezeState<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeState(child);
  return Object.freeze(value);
}
export function sameFields(a: object, b: object): boolean {
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) && Object.getOwnPropertyDescriptor(b, key)?.value === value,
    )
  );
}
