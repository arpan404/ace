import { z } from "zod";
const str = z.string().max(65_536);
export const GitHubPr = z.looseObject({
  number: z.number().int().positive(),
  node_id: str,
  title: str,
  html_url: str,
  state: str,
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: str.nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  head: z.looseObject({ sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/), ref: str }),
});
export const GitHubCheck = z.looseObject({
  id: z.number().int().positive(),
  name: str,
  status: str,
  conclusion: str.nullable(),
  completed_at: str.nullable(),
  details_url: str.nullable().optional(),
  html_url: str.nullable().optional(),
});
export const GitHubStatus = z.looseObject({
  id: z.number().int().positive(),
  context: str,
  state: str,
  updated_at: str,
  target_url: str.nullable(),
});
export const GitHubComment = z.looseObject({
  id: z.number().int().positive(),
  body: str,
  user: z.looseObject({ login: str }).nullable(),
  path: str.optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  updated_at: str,
  in_reply_to_id: z.number().int().positive().optional(),
});
export const CheckPage = z
  .looseObject({ check_runs: z.array(GitHubCheck).max(100) })
  .transform((value) => value.check_runs);
export const CommentPage = z.array(GitHubComment).max(100);
export const StatusPage = z.array(GitHubStatus).max(100);
const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: str.nullable() });
export const ReviewThreadsPage = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: PageInfo,
          nodes: z
            .array(
              z.object({
                id: str,
                isResolved: z.boolean(),
                isOutdated: z.boolean(),
                path: str,
                line: z.number().int().nullable(),
                comments: z.object({
                  pageInfo: PageInfo,
                  nodes: z
                    .array(
                      z.object({
                        databaseId: z.number().int().positive(),
                        body: str,
                        updatedAt: str,
                        author: z.object({ login: str }).nullable(),
                      }),
                    )
                    .max(100),
                }),
              }),
            )
            .max(100),
        }),
      }),
    }),
  }),
});
export const ReviewCommentConnection = z.object({
  data: z.object({
    node: z.object({
      comments: z.object({
        pageInfo: PageInfo,
        nodes: z
          .array(
            z.object({
              databaseId: z.number().int().positive(),
              body: str,
              updatedAt: str,
              author: z.object({ login: str }).nullable(),
            }),
          )
          .max(100),
      }),
    }),
  }),
});

export const GitHubReview = z.looseObject({
  id: z.number().int().positive(),
  body: str.nullable(),
  state: z.string().max(256),
  user: z.looseObject({ login: str }).nullable(),
  submitted_at: str.nullable().optional(),
});
export const ReviewPage = z.array(GitHubReview).max(100);
