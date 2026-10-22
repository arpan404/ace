import type {
  CommandPayload,
  CommandResult,
  ForgeBrowserResult,
  ForgeLatestReview,
  ForgePrReviewers,
  ForgeReference,
  ForgeRequestedReviewer,
  WorkspaceActionRequest,
} from "@ace/protocol";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";
import { people, reviewSeeds, suggestedLogins } from "./catalog/pr-people.ts";

type Op = WorkspaceActionRequest["operation"];
type Reviewers = { requested: ForgeRequestedReviewer[]; reviews: ForgeLatestReview[] };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * `@` people, `#` references and each catalog PR's reviewers, as GitHub answers them; review
 * requests, withdrawals and dismissals change what later reads show.
 */
export class FakePrPeople {
  private state = new Map<number, Reviewers>();
  private reviewers(fixture: PullRequestFixture): Reviewers {
    const number = fixture.detail.status.ref.number;
    const known = this.state.get(number);
    if (known) return known;
    const seed = reviewSeeds[number];
    const reviews = seed?.reviews ?? [];
    const initial: Reviewers = {
      reviews,
      requested: [
        ...fixture.detail.reviewers
          .filter((login) => !reviews.some((r) => same(r.login, login)))
          .map((login): ForgeRequestedReviewer => ({ kind: "user", login })),
        ...(seed?.teams ?? []),
      ],
    };
    this.state.set(number, initial);
    return initial;
  }
  /** The logins asked now, for the PR detail's reviewer list. */
  requestedLogins(fixture: PullRequestFixture): string[] {
    return this.reviewers(fixture).requested.flatMap((r) => (r.kind === "user" ? [r.login] : []));
  }
  read(
    op: Op,
    fixtures: readonly PullRequestFixture[],
    issues: (state: "open" | "closed") => readonly { ref: { number: number }; title: string }[],
    find: (op: Op) => PullRequestFixture | undefined,
  ): ForgeBrowserResult | undefined {
    if (op.op === "forge.people") {
      const query = op.query.trim().toLowerCase();
      return {
        resource: "people",
        people: people
          .filter(
            (p) =>
              !query ||
              p.login.toLowerCase().includes(query) ||
              p.name?.toLowerCase().includes(query),
          )
          .slice(0, 20),
      };
    }
    if (op.op === "forge.references") return references(op, fixtures, issues);
    if (op.op !== "forge.pr.reviewers") return undefined;
    const fixture = find(op);
    if (!fixture) return undefined;
    const { requested, reviews } = this.reviewers(fixture);
    const open = fixture.detail.status.state === "open" || fixture.detail.status.state === "draft";
    const author = fixture.detail.author;
    const value: ForgePrReviewers = {
      requested,
      reviews,
      suggested: suggestedLogins
        .filter((login) => !same(login, author))
        .flatMap((login) => {
          const person = people.find((p) => p.login === login);
          return person ? [{ ...person, isAuthor: false, isCommenter: login === "priya" }] : [];
        }),
      author,
      canRequest: open,
      canDismiss: open,
    };
    return { resource: "prReviewers", value };
  }
  /** `forge.hosted.review` reviewer actions on a catalog PR; anything else is not ours. */
  review(
    payload: CommandPayload,
    find: (pr: { repository: unknown; number: number }) => PullRequestFixture | undefined,
  ): Omit<CommandResult, "commandId"> | undefined {
    if (payload.type !== "forge.hosted.review") return undefined;
    const { action } = payload;
    if (
      action.kind !== "reviewers.request" &&
      action.kind !== "reviewers.remove" &&
      action.kind !== "review.dismiss"
    )
      return undefined;
    const fixture = find(payload.pr);
    if (!fixture) return { ok: false, error: "forge_not_found" };
    const current = this.reviewers(fixture);
    const number = fixture.detail.status.ref.number;
    if (action.kind === "review.dismiss") {
      const target = current.reviews.find((r) => r.id === action.reviewId);
      if (!target || (target.state !== "APPROVED" && target.state !== "CHANGES_REQUESTED"))
        return { ok: false, error: "forge_conflict" };
      this.state.set(number, {
        ...current,
        reviews: current.reviews.map((r) => (r === target ? { ...r, state: "DISMISSED" } : r)),
      });
      return { ok: true };
    }
    const teams = action.teams ?? [];
    const named = (r: ForgeRequestedReviewer) =>
      r.kind === "user"
        ? action.reviewers.some((login) => same(login, r.login))
        : teams.some((slug) => same(slug, r.slug));
    const kept = current.requested.filter((r) => !named(r));
    const added: ForgeRequestedReviewer[] =
      action.kind === "reviewers.request"
        ? [
            ...action.reviewers.map((login): ForgeRequestedReviewer => ({ kind: "user", login })),
            ...teams.map((slug): ForgeRequestedReviewer => ({ kind: "team", slug, name: slug })),
          ]
        : [];
    this.state.set(number, { ...current, requested: [...kept, ...added] });
    return { ok: true };
  }
}

function references(
  op: Extract<Op, { op: "forge.references" }>,
  fixtures: readonly PullRequestFixture[],
  issues: (state: "open" | "closed") => readonly { ref: { number: number }; title: string }[],
): ForgeBrowserResult {
  const query = op.query.trim().toLowerCase();
  const inRepository = fixtures.filter(
    (f) =>
      !op.repository || JSON.stringify(f.detail.status.ref.repository) === JSON.stringify(op.repository),
  );
  const all: ForgeReference[] = [
    ...inRepository.map((f): ForgeReference => {
      const state = f.detail.status.state;
      return {
        number: f.detail.status.ref.number,
        title: f.detail.status.title,
        kind: "pr",
        state: state === "unknown" ? "open" : state,
      };
    }),
    ...(["open", "closed"] as const).flatMap((state) =>
      issues(state).map(
        (row): ForgeReference => ({ number: row.ref.number, title: row.title, kind: "issue", state }),
      ),
    ),
  ];
  const matches = all.filter(
    (r) => !query || String(r.number).startsWith(query) || r.title.toLowerCase().includes(query),
  );
  const seen = new Set<number>();
  return {
    resource: "references",
    references: matches
      .toSorted((a, b) => Number(b.state === "open" || b.state === "draft") - Number(a.state === "open" || a.state === "draft"))
      .filter((r) => !seen.has(r.number) && seen.add(r.number))
      .slice(0, 20),
  };
}
