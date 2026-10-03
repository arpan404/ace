import { expect, it } from "vitest";
import { PartitionPool } from "./partition-pool.ts";

it("never gives two open sessions the same partition", () => {
  const pool = new PartitionPool("ephemeral-");
  const open = Array.from({ length: 8 }, () => pool.acquire());
  expect(new Set(open).size).toBe(8);
});

it("lends a closed session's partition again once its data was cleared", () => {
  const pool = new PartitionPool("ephemeral-");
  const first = pool.acquire();
  const second = pool.acquire();
  pool.release(first, true);
  const third = pool.acquire();
  expect(third).toBe(first);
  expect(third).not.toBe(second);
});

it("retires a partition whose data could not be cleared", () => {
  const pool = new PartitionPool("ephemeral-");
  const dirty = pool.acquire();
  pool.release(dirty, false);
  const lent = Array.from({ length: 4 }, () => pool.acquire());
  expect(lent).not.toContain(dirty);
});

it("stays at the most sessions ever open at once, however many sessions come and go", () => {
  const pool = new PartitionPool("ephemeral-");
  for (let round = 0; round < 1_000; round++) {
    const open = [pool.acquire(), pool.acquire(), pool.acquire()];
    for (const partition of open) pool.release(partition, true);
  }
  expect(pool.size()).toBe(3);
});

it("ignores a second release of the same partition", () => {
  const pool = new PartitionPool("ephemeral-");
  const partition = pool.acquire();
  pool.release(partition, true);
  pool.release(partition, true);
  const a = pool.acquire();
  const b = pool.acquire();
  expect(a).not.toBe(b);
});
