import type { ForgeLatestReview, ForgePerson, ForgeRequestedReviewer } from "@ace/protocol";

/*
 * The people of the design's repositories: who `@` finds, who GitHub suggests as reviewers, and
 * the reviews and team requests the sample pull requests start with.
 */

export const people: ForgePerson[] = [
  { login: "you", name: "You" },
  { login: "mira", name: "Mira Okafor" },
  { login: "sam", name: "Sam Lindqvist" },
  { login: "ola", name: "Ola Nordmann" },
  { login: "dana", name: "Dana Whitfield" },
  { login: "priya", name: "Priya Raman" },
  { login: "jonas", name: "Jonas Becker" },
  { login: "kenji", name: "Kenji Sato" },
  { login: "lena", name: "Lena Duarte" },
  { login: "theo", name: "Theo Marchetti" },
  { login: "ci-bot" },
];

/** GitHub's suggestions, by who last touched the changed lines. */
export const suggestedLogins = ["jonas", "priya", "kenji"];

/** Reviews and team requests a sample PR starts with, beyond the people asked in its detail. */
export const reviewSeeds: Record<
  number,
  { reviews: ForgeLatestReview[]; teams?: ForgeRequestedReviewer[] }
> = {
  31: {
    reviews: [
      {
        id: 9312,
        login: "mira",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-10-20T10:00:00.000Z",
      },
      { id: 9313, login: "dana", state: "COMMENTED", submittedAt: "2026-10-20T11:00:00.000Z" },
    ],
  },
  229: {
    reviews: [
      { id: 9229, login: "mira", state: "APPROVED", submittedAt: "2026-10-21T09:00:00.000Z" },
      {
        id: 9230,
        login: "priya",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-10-21T09:30:00.000Z",
      },
    ],
    teams: [{ kind: "team", slug: "client-core", name: "Client core" }],
  },
};
