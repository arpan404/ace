import { z } from "zod";
import type { ForgeReviewAction } from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { decode, type ReviewIo } from "./review-io.ts";

type ReviewerAction = Extract<
  ForgeReviewAction,
  { kind: "reviewers.request" | "reviewers.remove" | "review.dismiss" }
>;
const text = z.string().max(65_536);
const Requested = z.looseObject({
  users: z.array(z.looseObject({ login: text })).max(1_000),
  teams: z
    .array(z.looseObject({ slug: text }))
    .max(1_000)
    .optional(),
});
const Review = z.looseObject({
  id: z.number().int().positive(),
  state: text,
  user: z.looseObject({ login: text }).nullable().optional(),
});
/** A review that stands as a verdict until the next one; comments and drafts don't. */
const verdicts = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
/** Only a verdict can be dismissed: comments and pending reviews have nothing to take back. */
const dismissible = new Set(["APPROVED", "CHANGES_REQUESTED"]);
const asked = (name: string, set: Set<string>) => set.has(name.toLowerCase());

export function isReviewerAction(action: ForgeReviewAction): action is ReviewerAction {
  return (
    action.kind === "reviewers.request" ||
    action.kind === "reviewers.remove" ||
    action.kind === "review.dismiss"
  );
}

/** Review requests and dismissals on one PR, each confirmed by reading GitHub back. */
export class GitHubReviewerWrites {
  readonly #io: ReviewIo;
  constructor(io: ReviewIo) {
    this.#io = io;
  }
  async #requested(number: number, signal: AbortSignal) {
    const body = (
      await this.#io.request(`${this.#io.root}/pulls/${number}/requested_reviewers`, signal)
    ).body;
    const requested = decode(Requested, body);
    return {
      users: new Set(requested.users.map((u) => u.login.toLowerCase())),
      teams: new Set((requested.teams ?? []).map((t) => t.slug.toLowerCase())),
    };
  }
  async #review(number: number, id: number, signal: AbortSignal) {
    return decode(
      Review,
      (await this.#io.request(`${this.#io.root}/pulls/${number}/reviews/${id}`, signal)).body,
    );
  }
  async reconcile(number: number, action: ReviewerAction, signal: AbortSignal) {
    if (action.kind === "review.dismiss")
      return (await this.#review(number, action.reviewId, signal)).state === "DISMISSED";
    const { users, teams } = await this.#requested(number, signal);
    const want = action.kind === "reviewers.request";
    return (
      action.reviewers.every((name) => asked(name, users) === want) &&
      (action.teams ?? []).every((slug) => asked(slug, teams) === want)
    );
  }
  async write(
    number: number,
    action: ReviewerAction,
    host: { pr: { state: string } },
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ) {
    if (host.pr.state !== "OPEN") throw new ForgeError("conflict");
    if (action.kind === "review.dismiss") {
      const review = await this.#review(number, action.reviewId, signal);
      if (!dismissible.has(review.state)) throw new ForgeError("conflict");
      // Only the reviewer's standing verdict is dismissed: one they have since replaced (an
      // approval followed by a change request) would be taken back while the new one stands.
      const login = review.user?.login.toLowerCase();
      const theirs = (
        await this.#io.records(
          `${this.#io.root}/pulls/${number}/reviews?per_page=100`,
          Review,
          signal,
        )
      ).filter((r) => login !== undefined && r.user?.login.toLowerCase() === login);
      if (theirs.findLast((r) => verdicts.has(r.state))?.id !== action.reviewId)
        throw new ForgeError("conflict");
      if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
      const response = await this.#io.request(
        `${this.#io.root}/pulls/${number}/reviews/${action.reviewId}/dismissals`,
        signal,
        { message: action.message, event: "DISMISS" },
        "PUT",
        dispatch,
      );
      if (decode(Review, response.body).state !== "DISMISSED") throw new ForgeError("invalid_data");
      return;
    }
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    const response = await this.#io.request(
      `${this.#io.root}/pulls/${number}/requested_reviewers`,
      signal,
      {
        reviewers: action.reviewers,
        ...(action.teams?.length ? { team_reviewers: action.teams } : {}),
      },
      action.kind === "reviewers.request" ? "POST" : "DELETE",
      dispatch,
    );
    decode(z.looseObject({ number: z.number().int().positive() }), response.body);
  }
}
