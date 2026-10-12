import { expect, it } from "vitest";
import { exploreAction } from "./explore-command.ts";

it("reads, listings and searches count as exploring, piped through formatting helpers", () => {
  expect(exploreAction("cat src/a.ts")).toBe("read");
  expect(exploreAction("sed -n '1,80p' src/a.ts")).toBe("read");
  expect(exploreAction("ls -la apps")).toBe("list");
  expect(exploreAction("find . -name '*.ts' | head -20")).toBe("list");
  expect(exploreAction("rg -n 'lastAckedSeq' apps | head")).toBe("search");
  expect(exploreAction("cd apps/web && git grep -n Working")).toBe("search");
  expect(exploreAction("grep -rn foo src | sort | uniq -c")).toBe("search");
});

it("anything that can change something, or that it cannot read, is a plain command", () => {
  expect(exploreAction("bun run test")).toBeUndefined();
  expect(exploreAction("cat a.ts > b.ts")).toBeUndefined();
  expect(exploreAction("sed -i 's/a/b/' a.ts")).toBeUndefined();
  expect(exploreAction("find . -name '*.tmp' -delete")).toBeUndefined();
  expect(exploreAction("rg foo && rm -rf dist")).toBeUndefined();
  expect(exploreAction("cat $(ls)")).toBeUndefined();
  expect(exploreAction("git push")).toBeUndefined();
});

it("a backgrounded or second-line command is read too, and can make the whole thing a command", () => {
  expect(exploreAction("rg foo & rm -rf dist")).toBeUndefined();
  expect(exploreAction("ls\nrm -rf x")).toBeUndefined();
  expect(exploreAction("ls src\ncat a.ts")).toBe("read");
});

it("options that write a file or run a program are not exploring", () => {
  expect(exploreAction("sort -o out.txt names.txt")).toBeUndefined();
  expect(exploreAction("git diff --output=patch.diff")).toBeUndefined();
  expect(exploreAction("rg --pre ./run.sh foo")).toBeUndefined();
  expect(exploreAction("fd -x rm")).toBeUndefined();
  expect(exploreAction("find . -fprint out")).toBeUndefined();
  expect(exploreAction("sed -n 'w out.txt' a.ts")).toBeUndefined();
  expect(exploreAction("sed -n '$p' a.ts")).toBe("read");
  expect(exploreAction("git diff HEAD~1")).toBe("read");
});
