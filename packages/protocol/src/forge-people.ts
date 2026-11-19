import { z } from "zod";
import { ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

const text = z.string().max(65_536);
const login = z.string().min(1).max(100);
const avatarUrl = text.optional();

/** Someone who can be @mentioned or asked to review. */
export const ForgePerson = z.object({
  login,
  /** Their display name, when they set one. */
  name: z.string().max(256).optional(),
  avatarUrl,
});
export type ForgePerson = z.infer<typeof ForgePerson>;

/** An issue or pull request a `#number` can point at. */
export const ForgeReference = z.object({
  number: z.number().int().positive(),
  title: text,
  kind: z.enum(["issue", "pr"]),
  state: z.enum(["open", "draft", "closed", "merged"]),
});
export type ForgeReference = z.infer<typeof ForgeReference>;

/** A review GitHub keeps as someone's latest verdict on a pull request. */
export const ForgeLatestReview = z.object({
  /** The REST id, which dismissal names. */
  id: z.number().int().positive(),
  login,
  avatarUrl,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  submittedAt: text.nullable(),
  /** The head their latest review was made at, when GitHub still knows it. */
  commitSha: z
    .string()
    .regex(/^[a-fA-F0-9]{40,64}$/)
    .nullable()
    .optional(),
});
export type ForgeLatestReview = z.infer<typeof ForgeLatestReview>;

/** Who is asked to review: a person or a team. */
export const ForgeRequestedReviewer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), login, avatarUrl }),
  /** `slug` is the team's name in its organization, as requests name it. */
  z.object({ kind: z.literal("team"), slug: login, name: z.string().max(256) }),
]);
export type ForgeRequestedReviewer = z.infer<typeof ForgeRequestedReviewer>;

/** A pull request's reviewers as the Reviewers section manages them. */
export const ForgePrReviewers = z.object({
  /** Asked and not yet answered (a re-request puts a reviewer back here). */
  requested: z.array(ForgeRequestedReviewer).max(100),
  /** Each reviewer's latest review. */
  reviews: z.array(ForgeLatestReview).max(100),
  /** GitHub's suggestions, from who touched the changed lines. */
  suggested: z
    .array(ForgePerson.extend({ isAuthor: z.boolean(), isCommenter: z.boolean() }))
    .max(100),
  author: login.nullable(),
  /** The login `gh` is signed in as, when GitHub said: whose review is "yours". */
  viewer: login.nullable().optional(),
  /** The viewer may ask for or withdraw review requests. */
  canRequest: z.boolean(),
  /** The viewer may dismiss approving and changes-requested reviews. */
  canDismiss: z.boolean(),
});
export type ForgePrReviewers = z.infer<typeof ForgePrReviewers>;

/**
 * What a `@` or `#` search may hold: words, numbers, dots, dashes and spaces. Nothing GitHub's
 * search reads as a qualifier (`repo:`, quotes) can pass, so a search stays in its repository.
 */
export const ForgeCompletionQuery = z
  .string()
  .max(100)
  .regex(/^[\w .-]*$/)
  .default("");
const scope = { workspaceId: WorkspaceId, repository: ForgeRepository.optional() };
export const ForgePeopleOperations = [
  /** The repository's mentionable people whose login or name matches `query`; 20 at most. */
  z.object({ op: z.literal("forge.people"), ...scope, query: ForgeCompletionQuery }),
  /** Issues and PRs matching a number or title words: open ones first, then recent. */
  z.object({ op: z.literal("forge.references"), ...scope, query: ForgeCompletionQuery }),
  z.object({ op: z.literal("forge.pr.reviewers"), ...scope, number: z.number().int().positive() }),
] as const;
export const ForgePeopleResults = [
  z.object({ resource: z.literal("people"), people: z.array(ForgePerson).max(20) }),
  z.object({ resource: z.literal("references"), references: z.array(ForgeReference).max(20) }),
  z.object({ resource: z.literal("prReviewers"), value: ForgePrReviewers }),
] as const;
