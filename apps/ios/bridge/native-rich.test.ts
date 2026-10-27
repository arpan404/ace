import { expect, test } from "vitest";
import { readNativeRich } from "./native-rich.ts";

/* A finished answer's math, code colours and diff lines, as the phone asks for them. */

test("a finished answer's math reads as text, its code fences untouched", async () => {
  const reply = await readNativeRich({
    type: "native.rich",
    kind: "prose",
    text: "Spread is $\\sigma^2$.\n```ts\nconst cost = $x$;\n```",
  });
  expect(reply.text).toBe("Spread is σ².\n```ts\nconst cost = $x$;\n```");
});

test("a code fence gets grammar colours that cover its text exactly", async () => {
  const text = "const n = 1; // one";
  const reply = await readNativeRich({ type: "native.rich", kind: "code", language: "ts", text });
  expect(reply.colours?.length).toBeGreaterThan(0);
  const runs = reply.runs ?? [];
  expect(runs.filter((_, index) => index % 2 === 0).reduce((sum, length) => sum + length, 0)).toBe(
    text.length,
  );
});

test("a diff fence's lines are classified added, removed and hunk; an unknown language is plain", async () => {
  const reply = await readNativeRich({
    type: "native.rich",
    kind: "code",
    language: "diff",
    text: "@@ -1 +1 @@\n-old\n+new\n same",
  });
  expect(reply.diff?.map((line) => line.kind)).toEqual(["hunk", "del", "add", "context"]);
  const plain = await readNativeRich({
    type: "native.rich",
    kind: "code",
    language: "zz",
    text: "x",
  });
  expect(plain).toEqual({ diff: null, colours: [], runs: [] });
});
