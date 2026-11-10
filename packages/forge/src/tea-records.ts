import { z } from "zod";
import { ForgeRepository, ForgePrStatus, ForgePrRef } from "@ace/protocol/forge";
import { ForgePrRow } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import { clipText, clipLabels } from "./host-text.ts";
import { redactData } from "./redact.ts";

export const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const person = z.looseObject({ login: z.string() });
const branch = z.looseObject({
  sha,
  ref: z.string(),
  repo: z.looseObject({ name: z.string(), owner: person }).nullable().optional(),
});
export const pull = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  head: branch,
  base: branch,
  user: person.nullable().optional(),
  labels: z
    .array(z.looseObject({ name: z.string() }))
    .nullable()
    .optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  mergeable: z.boolean().optional(),
});
export type Pull = z.infer<typeof pull>;
export function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
export function ref(repository: ForgeRepository, number: number) {
  return decode(ForgePrRef, { repository, number });
}
export function state(p: Pull): "open" | "draft" | "closed" | "merged" | "unknown" {
  if (p.merged === true) return "merged";
  if (p.state === "closed") return "closed";
  if (p.state !== "open") return "unknown";
  return p.draft === true || /^(?:\[WIP\]|WIP:|\[DRAFT\]|DRAFT:)/i.test(p.title) ? "draft" : "open";
}
export function pullUrl(repo: ForgeRepository, number: number) {
  return `https://${repo.host}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${number}`;
}
export function status(repo: ForgeRepository, p: Pull) {
  const s = state(p);
  return decode(ForgePrStatus, {
    ref: ref(repo, p.number),
    title: clipText(p.title),
    url: pullUrl(repo, p.number),
    headSha: p.head.sha,
    state: s,
    // Gitea's `mergeable` means no conflicts, and Gitea reports false for drafts; a draft is
    // never mergeable here either, whatever the field says.
    mergeability: s === "open" && p.mergeable === true ? "mergeable" : "unknown",
    ci: "unknown",
    checks: [],
    comments: [],
    reviewThreads: [],
    raw: redactData(p),
  });
}
export function row(repo: ForgeRepository, p: Pull) {
  const s = state(p);
  if (s === "unknown") return null;
  return decode(ForgePrRow, {
    ref: ref(repo, p.number),
    title: clipText(p.title),
    url: pullUrl(repo, p.number),
    author: clipText(p.user?.login ?? ""),
    state: s,
    labels: labels(p),
    updatedAt: p.updated_at ?? "",
    headSha: p.head.sha,
    headBranch: clipText(p.head.ref),
    baseBranch: clipText(p.base.ref),
    raw: redactData(p),
  });
}
export function labels(p: Pull) {
  return clipLabels((p.labels ?? []).map((l) => l.name));
}
export function headRepository(repo: ForgeRepository, p: Pull) {
  const source = p.head.repo;
  if (!source) return null;
  return decode(ForgeRepository, {
    forge: repo.forge,
    host: repo.host,
    owner: source.owner.login,
    name: source.name,
  });
}
