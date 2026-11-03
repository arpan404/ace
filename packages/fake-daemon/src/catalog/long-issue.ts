import { ForgeIssueDetail, type ForgeBrowserResult } from "@ace/protocol";
import { colors } from "../forge-list-rows.ts";

const minute = 60_000;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const people = ["mira", "sam", "dana", "you"];
const notes = [
  "Still seeing it on the latest build.",
  "Can't reproduce on a fresh profile.",
  "Happens after the laptop sleeps for an hour or more.",
  "Attached a log from the daemon side.",
  "Same here, desktop app on macOS.",
];

/**
 * A busy issue: 62 conversation entries over three pages of 25, so the page opens on the newest
 * and earlier ones load on request.
 */
export function longIssueReads(now: number): {
  detail: ForgeBrowserResult;
  pages: ForgeBrowserResult[];
} {
  const count = 62;
  const events = Array.from({ length: count }, (_, index) => {
    const at = iso(now - (count - index) * 20 * minute);
    const actor = people[index % people.length] ?? "mira";
    if (index === count - 1)
      return {
        id: `c-250-${index}`,
        kind: "issue_comment" as const,
        event: "commented",
        actor: "dana",
        at,
        body: "Newest: the fix in #229 looks right. I'll close this once it ships.",
        raw: {},
      };
    if (index % 6 === 5)
      return {
        id: `e-250-${index}`,
        kind: "activity" as const,
        event: "labeled",
        actor,
        at,
        raw: { label: { name: "providers" } },
      };
    return {
      id: `c-250-${index}`,
      kind: "issue_comment" as const,
      event: "commented",
      actor,
      at,
      body: `${notes[index % notes.length]} (${index + 1})`,
      raw: {},
    };
  });
  const comments = events.filter((event) => event.kind === "issue_comment").length;
  const pages = Math.ceil(count / 25);
  const labels = ["bug", "providers"];
  return {
    detail: {
      resource: "issueDetail",
      value: ForgeIssueDetail.parse({
        ref: {
          repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
          number: 250,
        },
        title: "Reconnect loop spins after the laptop wakes from sleep",
        url: "https://github.com/acme/ace/issues/250",
        author: "mira",
        state: "open",
        labels,
        labelColors: colors(labels),
        assignees: ["sam"],
        milestone: "October polish",
        milestoneNumber: 3,
        commentCount: comments,
        createdAt: iso(now - (count + 3) * 20 * minute),
        updatedAt: iso(now - 20 * minute),
        body: "After sleep the client retries without a pause and pins a core.",
        permissions: {
          edit: true,
          close: true,
          reopen: true,
          comment: true,
          triage: true,
          reason: "",
        },
        relatedThreads: [],
        relatedThreadsTruncated: false,
      }),
    },
    pages: Array.from({ length: pages }, (_, index) => ({
      resource: "issueTimeline",
      events: events.slice(index * 25, index * 25 + 25),
      ...(index + 1 < pages ? { nextPage: index + 2 } : {}),
      lastPage: pages,
      truncated: false,
    })),
  };
}
