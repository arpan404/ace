import { z } from "zod";
import { AutomationEvent, AutomationTrigger, TriggerVariables } from "@ace/protocol";
import type { GhClient } from "./gh-process.ts";

const Stamp = z.string().max(128);
const Id = z.number().int().positive();
const Label = z.object({ name: z.string().max(256) });
const Resource = z.object({
  id: Id,
  updated_at: Stamp,
  html_url: z.string().max(2048),
  title: z.string().max(8192).optional(),
  body: z.string().nullable().optional(),
  number: Id.optional(),
  labels: z.array(Label).max(100).optional(),
  conclusion: z.string().max(128).nullable().optional(),
  pull_request: z.unknown().optional(),
  pull_requests: z
    .array(z.object({ number: Id }))
    .max(100)
    .optional(),
  pull_request_url: z.string().max(2048).optional(),
});
const Entry = z.object({
  id: z.string().max(128),
  version: Stamp,
  labels: z.array(z.string().max(256)).max(100),
  variables: TriggerVariables,
});
export type GithubEntry = z.infer<typeof Entry>;
const Page = z.object({
  endpoint: z.string().max(1024),
  etag: z.string().max(512).optional(),
  next: z.string().max(1024).optional(),
  entries: z.array(Entry).max(100),
});
export const GithubState = z.object({ pages: z.array(Page).max(20) });
export type GithubState = z.infer<typeof GithubState>;
const GithubTrigger = AutomationTrigger.options[2];
export type GithubTrigger = z.infer<typeof GithubTrigger>;
function endpoint(trigger: GithubTrigger): string {
  const base = `repos/${trigger.repository}`;
  switch (trigger.event) {
    case "pr_changed":
      return `${base}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
    case "ci_failed":
      return `${base}/actions/runs?status=failure&per_page=100`;
    case "review_comment":
      return `${base}/pulls/comments?sort=updated&direction=desc&per_page=100`;
    case "issue_labelled":
      return `${base}/issues?state=all&sort=updated&direction=desc&per_page=100`;
  }
}
function entries(data: unknown, trigger: GithubTrigger): GithubEntry[] {
  const resources =
    trigger.event === "ci_failed"
      ? z.object({ workflow_runs: z.array(Resource).max(100) }).parse(data).workflow_runs
      : z.array(Resource).max(100).parse(data);
  return resources.flatMap((resource) => {
    if (trigger.event === "issue_labelled" && resource.pull_request !== undefined) return [];
    if (trigger.event === "ci_failed" && resource.conclusion !== "failure") return [];
    if (
      trigger.pullRequest !== undefined &&
      (trigger.event === "ci_failed"
        ? !resource.pull_requests?.some((pr) => pr.number === trigger.pullRequest)
        : trigger.event === "review_comment"
          ? !resource.pull_request_url?.endsWith(`/${trigger.pullRequest}`)
          : resource.number !== trigger.pullRequest)
    )
      return [];
    return [
      Entry.parse({
        id: String(resource.id),
        version: resource.updated_at,
        labels: resource.labels?.map((label) => label.name) ?? [],
        variables: {
          repository: trigger.repository,
          url: resource.html_url,
          number: String(resource.number ?? resource.id),
          title: resource.title ?? "",
          body: (resource.body ?? "").slice(0, 8192),
          ...(trigger.event === "ci_failed"
            ? { pull_requests: resource.pull_requests?.map((pr) => pr.number).join(",") ?? "" }
            : {}),
        },
      }),
    ];
  });
}
export function githubEvents(
  trigger: GithubTrigger,
  previous: GithubState | undefined,
  current: GithubState,
): AutomationEvent[] {
  if (!previous) return [];
  const old = new Map(
    previous.pages.flatMap((page) => page.entries.map((entry) => [entry.id, entry] as const)),
  );
  const seen = new Set<string>();
  const events: AutomationEvent[] = [];
  const append = (event: unknown) => {
    if (events.length >= 2000) throw new Error("GitHub event batch exceeds limit");
    events.push(AutomationEvent.parse(event));
  };
  for (const entry of current.pages.flatMap((page) => page.entries)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const before = old.get(entry.id);
    if (before?.version === entry.version) continue;
    if (trigger.event === "issue_labelled") {
      const labels = new Set(before?.labels);
      for (const label of entry.labels)
        if (!labels.has(label) && (trigger.label === undefined || label === trigger.label))
          append({
            key: `github:${trigger.event}:${entry.id}:${entry.version}:${label}`,
            variables: { ...entry.variables, label },
          });
    } else
      append({
        key: `github:${trigger.event}:${entry.id}:${entry.version}`,
        variables: entry.variables,
      });
  }
  return events;
}
export async function pollGithub(
  client: GhClient,
  input: unknown,
  state: unknown,
  signal?: AbortSignal,
): Promise<{ state: GithubState; events: AutomationEvent[]; changed: boolean }> {
  const trigger = GithubTrigger.parse(input);
  const previous = GithubState.safeParse(state);
  const old = previous.success ? previous.data : undefined;
  const pages: GithubState["pages"] = [];
  let changed = false;
  let next: string | undefined = endpoint(trigger);
  const allowedPath = `repos/${trigger.repository}/`;
  while (next !== undefined) {
    if (pages.length >= 20 || pages.some((page) => page.endpoint === next))
      throw new Error("GitHub pagination exceeds bounded window");
    if (!next.startsWith(allowedPath)) throw new Error("GitHub pagination escaped repository");
    const prior = old?.pages.find((page) => page.endpoint === next);
    const response = await client.get(next, prior?.etag, signal);
    if (response.status === 304) {
      if (!prior) throw new Error("304 without a cached page");
      pages.push(prior);
      next = prior.next;
    } else {
      changed = true;
      if (response.status !== 200) throw new Error("Unexpected GitHub response status");
      const page = Page.parse({
        endpoint: next,
        entries: entries(response.data, trigger),
        ...(response.etag ? { etag: response.etag } : {}),
        ...(response.next ? { next: response.next } : {}),
      });
      pages.push(page);
      next = page.next;
    }
  }
  if (!changed && old) return { state: old, events: [], changed: false };
  const current: GithubState = { pages };
  return { state: current, events: githubEvents(trigger, old, current), changed: true };
}
