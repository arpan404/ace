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
