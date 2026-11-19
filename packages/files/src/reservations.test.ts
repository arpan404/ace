import { expect, it } from "vitest";
import { PathReservations, overlaps, within } from "./reservations.ts";

it("holds a mutation on a held path and lets an unrelated path through", async () => {
  const reservations = new PathReservations();
  const release = await reservations.reserve(["docs/a.md"]);

  const order: string[] = [];
  const inside = reservations.reserve(["docs/a.md"]).then((done) => {
    order.push("inside");
    done();
  });
  const other = reservations.reserve(["src/b.md"]).then((done) => {
    order.push("other");
    done();
  });
  await other;
  // A mutation elsewhere never waits for a proof.
  expect(order).toEqual(["other"]);
  expect(reservations.idle).toBe(false);

  release();
  await inside;
  // The held path waits for its proof.
  expect(order).toEqual(["other", "inside"]);
  expect(reservations.idle).toBe(true);
});

it("treats a folder and everything inside it as one path", async () => {
  expect(overlaps(["docs"], ["docs/a.md"])).toBe(true);
  expect(overlaps(["docs/a.md"], ["docs"])).toBe(true);
  expect(overlaps(["docs"], ["docsx/a.md"])).toBe(false);
  expect(within("docs/a.md", "docs/a.md")).toBe(true);
  expect(within("docs", "docs2/a.md")).toBe(false);
});

it("releasing twice does not free another holder's reservation", async () => {
  const reservations = new PathReservations();
  const release = await reservations.reserve(["a.md"]);
  const other = await reservations.reserve(["b.md"]);

  release();
  release();

  expect(reservations.idle).toBe(false);
  other();
  expect(reservations.idle).toBe(true);
});
