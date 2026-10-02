import type { z } from "zod";
import type { GitHubCheck, GitHubComment, GitHubReview, GitHubStatus } from "./github-schemas.ts";
/** Only projected fields affect typed versions; unknown fields remain in raw pages. */
export const sameCheck = (a: z.infer<typeof GitHubCheck>, b: z.infer<typeof GitHubCheck>) =>
  a.name === b.name &&
  a.status === b.status &&
  a.conclusion === b.conclusion &&
  a.completed_at === b.completed_at &&
  a.details_url === b.details_url &&
  a.html_url === b.html_url;
export const sameStatus = (a: z.infer<typeof GitHubStatus>, b: z.infer<typeof GitHubStatus>) =>
  a.context === b.context &&
  a.state === b.state &&
  a.updated_at === b.updated_at &&
  a.target_url === b.target_url;
export const sameComment = (a: z.infer<typeof GitHubComment>, b: z.infer<typeof GitHubComment>) =>
  a.body === b.body &&
  a.user?.login === b.user?.login &&
  a.path === b.path &&
  a.line === b.line &&
  a.original_line === b.original_line &&
  a.updated_at === b.updated_at &&
  a.in_reply_to_id === b.in_reply_to_id;
export const sameReview = (a: z.infer<typeof GitHubReview>, b: z.infer<typeof GitHubReview>) =>
  a.body === b.body &&
  a.state === b.state &&
  a.user?.login === b.user?.login &&
  a.submitted_at === b.submitted_at;
