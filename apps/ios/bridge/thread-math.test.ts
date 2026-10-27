import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";
import { facts } from "@ace/fake-daemon";
import { afterEach, expect, test } from "vitest";

/*
 * A finished answer's row carries its formulas, so the phone reads them in their text form from
 * the first frame; an answer still streaming carries none, so a delta costs nothing more.
 */

afterEach(reset);

test("a finished answer's row carries its formulas; one still streaming carries none", async () => {
  const fake = fixture();
  fake.createThread({ id: "m", workspaceId: "ace", title: "Maths", provider: "codex" });
  fake.apply("m", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Spread?"),
    facts.message("root", "done", "assistant", "It is $\\sigma^2$."),
    facts.message("root", "live", "assistant", "Still writing $x^2", false),
  ]);
  open(connect(fake), "m");
  const done = await until(
    () => rows("thread.item").find((row) => row.text === "It is $\\sigma^2$."),
    "the answer",
  );
  expect(done.math).toEqual({
    text: "It is 0.",
    math: [{ tex: "\\sigma^2", display: false, text: "σ²" }],
  });
  const live = rows("thread.item").find((row) => row.text === "Still writing $x^2");
  expect(live?.math).toBeNull();
});
