import { z } from "zod";
import { GitHubPr } from "./github-schemas.ts";
const text = z.string().max(65_536);
export const User = z.looseObject({ login: text });
const Labels = z.array(z.looseObject({ name: text })).max(100);
const Repo = z.looseObject({ name: text, owner: User });
export const BrowserPr = GitHubPr.extend({
  body: text.nullable(),
  user: User.nullable(),
  labels: Labels,
  base: z.looseObject({ ref: text, sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/) }),
  head: GitHubPr.shape.head.extend({ repo: Repo.nullable() }),
  requested_reviewers: z.array(User).max(100),
  commits: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
});
export const SearchPage = z.looseObject({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z
    .array(
      z.looseObject({
        number: z.number().int().positive(),
        title: text,
        html_url: text,
        user: User.nullable(),
        state: z.enum(["open", "closed"]),
        draft: z.boolean().optional(),
        labels: Labels,
        updated_at: text,
        pull_request: z.looseObject({ merged_at: text.nullable().optional() }),
      }),
    )
    .max(25),
});
export const CommitRecord = z.looseObject({
  sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  html_url: text,
  commit: z.looseObject({
    message: text,
    author: z.looseObject({ name: text, date: text.nullable() }).nullable(),
  }),
  author: User.nullable(),
});
export const FileRecord = z.looseObject({
  filename: text,
  previous_filename: text.optional(),
  status: text,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(4_194_304).optional(),
});
export const CommitFiles = z.looseObject({
  ...CommitRecord.shape,
  parents: z.array(z.looseObject({ sha: z.string().regex(/^[a-fA-F0-9]{40,64}$/) })).max(100),
  files: z.array(FileRecord).max(25),
});
