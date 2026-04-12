import { describe, expect, it } from "vitest";

import { collectMarkdownImageUrlsFromThread } from "./githubIssueImages";

describe("githubIssueImages", () => {
  const baseThread = {
    number: 1,
    title: "Example",
    state: "open" as const,
    url: "https://github.com/acme/repo/issues/1",
    body: null,
    labels: [],
    assignees: [],
    author: null,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    comments: [],
  };

  it("collects markdown image URLs from the issue body and comments", () => {
    const thread = {
      ...baseThread,
      body: "See ![](https://user-images.githubusercontent.com/u/1/a.png)",
      comments: [
        {
          author: { login: "bob" },
          body: '<img src="https://private-user-images.githubusercontent.com/x/y.jpg" />',
          createdAt: "2026-04-08T00:01:00.000Z",
          updatedAt: null,
          url: null,
        },
      ],
    };
    expect(collectMarkdownImageUrlsFromThread(thread)).toEqual([
      "https://user-images.githubusercontent.com/u/1/a.png",
      "https://private-user-images.githubusercontent.com/x/y.jpg",
    ]);
  });

  it("resolves root-relative URLs against the issue page origin", () => {
    const thread = {
      ...baseThread,
      body: "![](/user-attachments/assets/abc)",
      comments: [],
    };
    expect(collectMarkdownImageUrlsFromThread(thread)).toEqual([
      "https://github.com/user-attachments/assets/abc",
    ]);
  });

  it("ignores disallowed hosts", () => {
    const thread = {
      ...baseThread,
      body: "![](https://evil.example/a.png)",
      comments: [],
    };
    expect(collectMarkdownImageUrlsFromThread(thread)).toEqual([]);
  });
});
