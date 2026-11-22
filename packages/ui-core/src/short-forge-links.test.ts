import { expect, test } from "vitest";
import { shortForgeLinks } from "./short-forge-links.ts";

test("pull request and issue links read as owner/repo#number inside a sentence", () => {
  expect(
    shortForgeLinks("Landed with tests passing. Opened https://github.com/acme/relay/pull/1041"),
  ).toBe("Landed with tests passing. Opened acme/relay#1041");
  expect(shortForgeLinks("Fixes https://github.com/acme/relay/issues/7, see the thread.")).toBe(
    "Fixes acme/relay#7, see the thread.",
  );
  expect(shortForgeLinks("https://gitlab.com/acme/relay/-/merge_requests/12")).toBe(
    "acme/relay#12",
  );
});

test("other links and words stay as they are", () => {
  const text = "Read https://example.com/docs/pull/ now";
  expect(shortForgeLinks(text)).toBe(text);
});
