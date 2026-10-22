import type { ForgeInboxRow, ForgeRepository } from "@ace/protocol";

/*
 * The person's GitHub notifications for the design's repositories: one of every reason and
 * subject type GitHub sends, plus a reason and a type it may add later, linking to the sample
 * pull requests and issues the fake already knows (ace #229, docs-site #31, ace #240).
 */

const minute = 60_000;
const hour = 60 * minute;
const iso = (at: number) => new Date(Math.max(0, at)).toISOString();
const repo = (name: string): ForgeRepository => ({
  forge: "github",
  host: "github.com",
  owner: "acme",
  name,
});
const web = (name: string, path = "") => `https://github.com/acme/${name}${path}`;

interface Sketch {
  id: string;
  name: string;
  type: string;
  title: string;
  reason: string;
  ago: number;
  unread?: boolean;
  number?: number;
  state?: ForgeInboxRow["state"];
  path?: string;
}

const sketches: Sketch[] = [
  {
    id: "9001",
    name: "ace",
    type: "PullRequest",
    title: "Reconnect the client worker after sleep",
    reason: "review_requested",
    ago: 12 * minute,
    number: 229,
    state: "open",
    path: "/pull/229",
  },
  {
    id: "9002",
    name: "docs-site",
    type: "PullRequest",
    title: "Rewrite the install page for the daemon",
    reason: "mention",
    ago: 31 * minute,
    number: 31,
    state: "open",
    path: "/pull/31",
  },
  {
    id: "9003",
    name: "ace",
    type: "Issue",
    title: "Sidebar loses its scroll position after archiving",
    reason: "assign",
    ago: 40 * minute,
    number: 240,
    state: "open",
    path: "/issues/240",
  },
  {
    id: "9004",
    name: "ace",
    type: "CheckSuite",
    title: "CI workflow run failed for feature/pulls-page",
    reason: "ci_activity",
    ago: 55 * minute,
    path: "/actions",
  },
  {
    id: "9005",
    name: "ace",
    type: "PullRequest",
    title: "Pull requests and issues as pages",
    reason: "comment",
    ago: 70 * minute,
    number: 231,
    state: "open",
    path: "/pull/231",
  },
  {
    id: "9006",
    name: "ace",
    type: "Discussion",
    title: "Roadmap for the native iOS client",
    reason: "team_mention",
    ago: 2 * hour,
    path: "/discussions",
  },
  {
    id: "9007",
    name: "billing-api",
    type: "RepositoryVulnerabilityAlert",
    title: "Critical severity vulnerability in pdfkit",
    reason: "security_alert",
    ago: 3 * hour,
    path: "/security/dependabot",
  },
  {
    id: "9008",
    name: "ace",
    type: "Release",
    title: "v0.0.8",
    reason: "subscribed",
    ago: 5 * hour,
    unread: false,
    path: "/releases",
  },
  {
    id: "9009",
    name: "billing-api",
    type: "Commit",
    title: "Round invoice totals half to even",
    reason: "comment",
    ago: 7 * hour,
    unread: false,
    path: "/commit/4f2a9c1d7e",
  },
  {
    id: "9010",
    name: "ace",
    type: "PullRequest",
    title: "Bump Codex app-server to 0.48",
    reason: "author",
    ago: 9 * hour,
    unread: false,
    number: 212,
    state: "merged",
    path: "/pull/212",
  },
  {
    id: "9011",
    name: "ace",
    type: "Issue",
    title: "Document the fake daemon's fixture worlds",
    reason: "state_change",
    ago: 26 * hour,
    unread: false,
    number: 230,
    state: "closed",
    path: "/issues/230",
  },
  {
    id: "9012",
    name: "ace",
    type: "Issue",
    title: "Show the merge queue position on the work card",
    reason: "manual",
    ago: 30 * hour,
    unread: false,
    number: 238,
    state: "open",
    path: "/issues/238",
  },
  {
    id: "9013",
    name: "ace",
    type: "PullRequest",
    title: "Draft: native host contract for iOS",
    reason: "team_mention",
    ago: 2 * 24 * hour,
    unread: false,
    number: 226,
    state: "draft",
    path: "/pull/226",
  },
  {
    id: "9014",
    name: "docs-site",
    type: "RepositoryInvitation",
    title: "Invitation to join acme/docs-site",
    reason: "invitation",
    ago: 3 * 24 * hour,
    unread: false,
  },
  {
    id: "9015",
    name: "ace",
    type: "CheckSuite",
    title: "Deploy to production is waiting for your approval",
    reason: "approval_requested",
    ago: 4 * 24 * hour,
    unread: false,
    path: "/actions",
  },
  {
    id: "9016",
    name: "ace",
    type: "SecurityCampaign",
    title: "Fix 3 alerts before the campaign ends",
    reason: "security_advisory_credit",
    ago: 5 * 24 * hour,
    unread: false,
  },
];

/** The fake's notifications as the daemon maps them, newest first. */
export function inboxNotifications(now: number): ForgeInboxRow[] {
  return sketches.map((sketch) => ({
    id: sketch.id,
    repository: repo(sketch.name),
    type: sketch.type,
    title: sketch.title,
    ...(sketch.number ? { number: sketch.number } : {}),
    ...(sketch.state ? { state: sketch.state } : {}),
    reason: sketch.reason,
    unread: sketch.unread ?? true,
    updatedAt: iso(now - sketch.ago),
    lastReadAt: sketch.unread === false ? iso(now - sketch.ago + minute) : null,
    url: web(sketch.name, sketch.path),
  }));
}
