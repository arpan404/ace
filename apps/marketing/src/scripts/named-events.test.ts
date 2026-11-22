import { expect, test } from "vitest";
import { links } from "../site.ts";
import { githubTarget, makerAction } from "./named-events.ts";

test("links into ace's repository are named by the part of GitHub they open", () => {
  expect(githubTarget(links.source)).toBe("repository");
  expect(githubTarget(`${links.source}/issues`)).toBe("issues");
  expect(githubTarget(`${links.source}/issues/new?template=bug.yml`)).toBe("issues");
  expect(githubTarget(links.latestRelease)).toBe("releases");
  expect(githubTarget(links.license)).toBe("license");
  expect(githubTarget(`${links.source}/blob/main/README.md`)).toBe("other");
});

test("links outside ace's repository are not GitHub clicks", () => {
  expect(githubTarget("https://github.com/anthropics/claude-code")).toBeUndefined();
  expect(githubTarget(`${links.source}-fork`)).toBeUndefined();
  expect(githubTarget("https://acehq.dev/faq/")).toBeUndefined();
});

test("each Spade maker control maps to one action", () => {
  expect(makerAction({ shuffle: "" }, false)).toBe("shuffle");
  expect(makerAction({ partField: "ears" }, false)).toBe("part");
  expect(makerAction({ value: "fox" }, true)).toBe("option");
  expect(makerAction({ name: "" }, false)).toBe("name");
  expect(makerAction({ task: "" }, false)).toBe("task");
});

test("a value outside the options row is not a maker option", () => {
  expect(makerAction({ value: "fox" }, false)).toBeUndefined();
  expect(makerAction({}, true)).toBeUndefined();
});
