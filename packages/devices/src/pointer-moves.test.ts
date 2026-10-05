import { expect, it } from "vitest";
import { coalescedPointerMoves } from "./video-client.ts";
it("slow input sends only the latest pointer move and an end event discards waiting motion", async () => {
  const seen: number[] = [];
  let blocked = Promise.withResolvers<void>();
  const moves = coalescedPointerMoves<number>(
    async (value) => {
      seen.push(value);
      await blocked.promise;
    },
    () => {},
  );
  moves.move(1);
  for (let i = 2; i <= 100; i++) moves.move(i);
  expect(seen).toEqual([1]);
  const first = blocked;
  blocked = Promise.withResolvers<void>();
  first.resolve();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(seen).toEqual([1, 100]);
  moves.move(101);
  moves.discard();
  blocked.resolve();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(seen).toEqual([1, 100]);
  moves.close();
  moves.move(102);
  expect(seen).toEqual([1, 100]);
});
it("a failed pointer move reports its error without replaying it", async () => {
  const errors: unknown[] = [];
  const seen: number[] = [];
  const moves = coalescedPointerMoves<number>(
    async (n) => {
      seen.push(n);
      throw new Error("lease expired");
    },
    (error) => errors.push(error),
  );
  moves.move(1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(seen).toEqual([1]);
  expect(errors).toHaveLength(1);
  moves.close();
});
