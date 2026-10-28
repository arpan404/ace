import { expect, test } from "vitest";
import { richCode, richProse } from "./native-rich.ts";

/* A finished answer's math, code colours and diff lines, as the phone asks for them. */

test("a finished answer's formulas are marked for typesetting with their text form; code fences untouched", async () => {
  const reply = richProse("Spread is $\\sigma^2$.\n```ts\nconst cost = $x$;\n```");
  expect(reply.text).toBe("Spread is \uE0000\uE001.\n```ts\nconst cost = $x$;\n```");
  expect(reply.math).toEqual([{ tex: "\\sigma^2", display: false, text: "σ²" }]);
});

test("a code fence gets grammar colours that cover its text exactly", async () => {
  const text = "const n = 1; // one";
  const reply = await richCode("ts", text);
  expect(reply.colours?.length).toBeGreaterThan(0);
  const runs = reply.runs ?? [];
  expect(runs.filter((_, index) => index % 2 === 0).reduce((sum, length) => sum + length, 0)).toBe(
    text.length,
  );
});

test("a diff fence's lines are classified added, removed and hunk; an unknown language is plain", async () => {
  const reply = await richCode("diff", "@@ -1 +1 @@\n-old\n+new\n same");
  expect(reply.diff?.map((line) => line.kind)).toEqual(["hunk", "del", "add", "context"]);
  const plain = await richCode("zz", "x");
  expect(plain).toEqual({ diff: null, colours: [], runs: [] });
});
