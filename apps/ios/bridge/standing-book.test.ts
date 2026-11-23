import { expect, test } from "vitest";
import { StandingBook } from "./standing-book.ts";

test("an older socket closing does not clear what a newer socket on another route proved", () => {
  const book = new StandingBook();
  book.set("direct-1", "proven", "direct");
  book.set("relay-1", "proven", "relay");
  book.set("direct-1", undefined, "direct");
  expect(book.active()).toEqual({ state: "proven", route: "relay" });
  book.set("relay-1", undefined, "relay");
  expect(book.active()).toBeUndefined();
});

test("the newest verdict is the one that counts, a refusal included", () => {
  const book = new StandingBook();
  book.set("direct-1", "proven", "direct");
  book.set("relay-1", "missing", "relay");
  expect(book.active()).toEqual({ state: "missing", route: "relay" });
});
