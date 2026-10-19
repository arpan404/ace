import { expect, test } from "vitest";
import { fakeGh, sha } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const timeline = (page: number) => `repos/octo/ace/issues/7/timeline?per_page=25&page=${page}`;
// GitHub links the next timeline page by repository id, not by owner and name.
const byIdLink = (path: string) => `<https://api.github.com/repositories/1401155797/${path}>`;

/** A scrubbed record shaped like GitHub's cross-reference: the whole referencing PR rides along. */
function crossReference(n: number) {
  return {
    event: "cross-referenced",
    actor: { login: "author", avatar_url: "https://avatars.example/u/1" },
    created_at: `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
    updated_at: `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
    source: {
      type: "issue",
      issue: {
        id: 9_000 + n,
        node_id: `PR_node${n}`,
        number: 900 + n,
        title: `Referencing change ${n}`,
        state: "open",
        user: { login: "author", id: 1, type: "User" },
        labels: [{ id: 1, name: "bug", color: "d73a4a", description: "Something isn't working" }],
        body: `Part of #7.\n\n${"Scrubbed description line.\n".repeat(400)}`,
        reactions: { total_count: 0, "+1": 0, "-1": 0 },
        pull_request: { html_url: `https://github.com/octo/ace/pull/${900 + n}`, merged_at: null },
        repository: { id: 1, full_name: "octo/ace", private: false, topics: [] },
      },
    },
  };
}

function pr888Shape() {
  const head = [
    {
      id: 1,
      event: "labeled",
      actor: { login: "author" },
      created_at: "2026-10-01T00:00:00Z",
      label: { name: "bug" },
    },
    {
      id: 2,
      event: "review_requested",
      actor: { login: "author" },
      created_at: "2026-10-01T00:00:00Z",
      requested_reviewer: { login: "reviewer" },
    },
    { node_id: "C_1", event: "committed", sha, author: { name: "author" } },
    {
      id: 3,
      event: "commented",
      actor: { login: "reviewer" },
      created_at: "2026-10-02T00:00:00Z",
      body: "Looks right.",
    },
    {
      id: 4,
      event: "reviewed",
      user: { login: "reviewer" },
      submitted_at: "2026-10-03T00:00:00Z",
      state: "approved",
    },
  ];
  const references = Array.from({ length: 11 }, (_, n) => crossReference(n));
  const filler = Array.from({ length: 9 }, (_, n) => ({
    id: 100 + n,
    event: "referenced",
    actor: { login: "author" },
    created_at: "2026-10-05T00:00:00Z",
    commit_id: sha,
  }));
  const tail = [
    {
      id: 200,
      event: "merged",
      actor: { login: "author" },
      created_at: "2026-10-20T00:00:00Z",
      commit_id: sha,
    },
    { id: 201, event: "closed", actor: { login: "author" }, created_at: "2026-10-20T00:00:00Z" },
    ...Array.from({ length: 4 }, (_, n) => crossReference(20 + n)),
  ];
  return { first: [...head, ...references, ...filler], second: tail };
}

test("a PR timeline with many cross-references reads every page when GitHub links the next one by repository id", async () => {
  const { first, second } = pr888Shape();
  const f = await fakeGh({
    [timeline(1)]: [
      {
        body: first,
        headers: { link: `${byIdLink(timeline(2).replace("repos/octo/ace/", ""))}; rel="next"` },
      },
    ],
    [timeline(2)]: [{ body: second }],
  });
  try {
    const one = await f.forge.prActivity(7, 1, signal());
    expect(one.events).toHaveLength(25);
    expect(one.nextPage).toBe(2);
    expect(one.truncated).toBe(false);
    expect(one.events.filter((e) => e.event === "cross-referenced")).toHaveLength(11);
    expect(one.events.slice(0, 3)).toMatchObject([
      { id: "1", event: "labeled", actor: "author", subject: "bug" },
      { id: "2", event: "review_requested", subject: "reviewer" },
      { id: "C_1", event: "committed", commitSha: sha },
    ]);
    expect(one.events[5]).toMatchObject({
      raw: {
        source: {
          issue: {
            number: 900,
            pull_request: { html_url: "https://github.com/octo/ace/pull/900" },
          },
        },
      },
    });
    const two = await f.forge.prActivity(7, 2, signal());
    expect(two.events.map((e) => e.event)).toEqual([
      "merged",
      "closed",
      "cross-referenced",
      "cross-referenced",
      "cross-referenced",
      "cross-referenced",
    ]);
    expect(two.nextPage).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("one timeline record ace cannot read is kept raw and the rest of the page still shows", async () => {
  const odd = {
    event: "cross-referenced",
    actor: { login: 42 },
    created_at: "2026-10-04T00:00:00Z",
  };
  const f = await fakeGh({
    [timeline(1)]: [
      {
        body: [
          {
            id: 1,
            event: "merged",
            actor: { login: "author" },
            created_at: "2026-10-01T00:00:00Z",
          },
          odd,
          { event: { nested: true } },
          {
            id: 2,
            event: "closed",
            actor: { login: "author" },
            created_at: "2026-10-02T00:00:00Z",
          },
        ],
      },
    ],
  });
  try {
    const result = await f.forge.prActivity(7, 1, signal());
    expect(result.events).toMatchObject([
      { id: "1", event: "merged", actor: "author" },
      { id: "1:1", event: "cross-referenced", actor: "GitHub", at: null, raw: odd },
      { id: "1:2", event: "unknown", raw: { event: { nested: true } } },
      { id: "2", event: "closed", actor: "author" },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a next link by repository id that names a different resource is refused", async () => {
  const f = await fakeGh({
    [timeline(1)]: [
      {
        body: [{ id: 1, event: "closed", actor: { login: "author" } }],
        headers: { link: `${byIdLink("issues/8/timeline?per_page=25&page=2")}; rel="next"` },
      },
    ],
  });
  try {
    await expect(f.forge.prActivity(7, 1, signal())).rejects.toMatchObject({
      kind: "invalid_data",
    });
  } finally {
    await f.cleanup();
  }
});
