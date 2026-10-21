import { expect, it } from "vitest";
import { coalescedPointerMoves } from "./pointer-moves.ts";

it("a drag sends moves without waiting for each round trip, up to its in-flight limit", async () => {
  const seen: number[] = [];
  const replies: (() => void)[] = [];
  const moves = coalescedPointerMoves<number>(
    (value) => {
      seen.push(value);
      return new Promise((resolve) => replies.push(resolve));
    },
    () => {},
    3,
  );
  for (let i = 1; i <= 3; i++) moves.move(i);
  // Three moves are on the wire before the device answered any of them.
  expect(seen).toEqual([1, 2, 3]);
  moves.move(4);
  moves.move(5);
  expect(seen).toEqual([1, 2, 3]);
  // An answer frees a slot for the newest waiting move only.
  replies.shift()?.();
  await expect.poll(() => seen).toEqual([1, 2, 3, 5]);
  for (const reply of replies.splice(0)) reply();
  await moves.settle();
  moves.close();
});

it("slow input sends only the latest move and discards waiting motion before the up event", async () => {
  const seen: (number | "up")[] = [];
  const first = Promise.withResolvers<void>();
  const last = Promise.withResolvers<void>();
  const latestSent = Promise.withResolvers<void>();
  const send = async (value: number | "up") => {
    seen.push(value);
    if (value === 1) await first.promise;
    if (value === 100) {
      latestSent.resolve();
      await last.promise;
    }
  };
  const moves = coalescedPointerMoves<number>(send, () => {}, 1);
  moves.move(1);
  for (let i = 2; i <= 100; i++) moves.move(i);
  expect(seen).toEqual([1]);
  first.resolve();
  await latestSent.promise;
  moves.move(101);
  moves.discard();
  // The same ordered input transport sends a discrete up immediately after discard.
  await send("up");
  last.resolve();
  await moves.settle();
  expect(seen).toEqual([1, 100, "up"]);
  moves.close();
  moves.move(102);
  await moves.settle();
  expect(seen).toEqual([1, 100, "up"]);
});

it("a failed move reports an error without replaying it", async () => {
  const seen: number[] = [];
  const failure = Promise.withResolvers<unknown>();
  const moves = coalescedPointerMoves<number>(async (n) => {
    seen.push(n);
    throw new Error("lease expired");
  }, failure.resolve);
  moves.move(1);
  await expect(failure.promise).resolves.toMatchObject({ message: "lease expired" });
  await moves.settle();
  expect(seen).toEqual([1]);
  moves.close();
});
