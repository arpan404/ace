import { z } from "zod";
import {
  ForgeIssueSearch,
  ForgeIssueList,
  ForgeIssueRow,
  ForgeIssueDetail,
  ForgeIssueEvent,
} from "@ace/protocol/forge-issues";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { CommandRunner } from "./command.ts";
import { teaGet } from "./tea-api.ts";
import { decode, person } from "./tea-records.ts";
import { ForgeError } from "./errors.ts";
import { clipText, clipLabels } from "./host-text.ts";
import { redactData } from "./redact.ts";

const issue = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(["open", "closed"]),
  user: person.nullable().optional(),
  labels: z
    .array(z.looseObject({ name: z.string() }))
    .nullable()
    .optional(),
  assignees: z.array(person).nullable().optional(),
  milestone: z.looseObject({ title: z.string() }).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});
const event = z.looseObject({
  id: z.number().int().positive(),
  type: z.string(),
  user: person.nullable().optional(),
  created_at: z.string().nullable().optional(),
  body: z.string().optional(),
});

/** Issue read contract shared by both API v1 hosts. No mutation permissions are inferred. */
export class TeaIssues {
  private options: { repository: ForgeRepository; runner: CommandRunner; login: string };
  private root: string;
  constructor(options: TeaIssues["options"]) {
    this.options = options;
    this.root = `repos/${encodeURIComponent(options.repository.owner)}/${encodeURIComponent(options.repository.name)}/issues`;
  }
  private get(path: string, signal: AbortSignal) {
    return teaGet(this.options.runner, this.options.login, `${this.root}${path}`, signal);
  }
  private row(data: z.infer<typeof issue>) {
    if (data.pull_request != null) throw new ForgeError("invalid_data");
    const r = this.options.repository;
    return decode(ForgeIssueRow, {
      ref: { repository: r, number: data.number },
      title: clipText(data.title),
      author: clipText(data.user?.login ?? ""),
      state: data.state,
      url: `https://${r.host}/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/issues/${data.number}`,
      labels: clipLabels((data.labels ?? []).map((l) => l.name)),
      assignees: (data.assignees ?? []).slice(0, 100).map((u) => clipText(u.login)),
      milestone: data.milestone ? clipText(data.milestone.title) : null,
      createdAt: clipText(data.created_at),
      updatedAt: clipText(data.updated_at),
      raw: redactData(data),
    });
  }
  async listIssues(input: ForgeIssueSearch, signal: AbortSignal) {
    const q = ForgeIssueSearch.parse(input);
    if (
      q.author ||
      q.assignee ||
      q.labels.length ||
      q.milestone ||
      q.sort !== "updated" ||
      q.order !== "desc"
    )
      throw new ForgeError("unsupported");
    const params = new URLSearchParams({
      state: q.state,
      type: "issues",
      page: String(q.page),
      limit: "25",
    });
    if (q.search) params.set("q", q.search);
    const response = await this.get(`?${params}`, signal);
    const data = decode(z.array(issue).max(25), response.body);
    const items = data.filter((i) => i.pull_request == null).map((i) => this.row(i));
    const more = response.total === undefined ? data.length === 25 : q.page * 25 < response.total;
    return decode(ForgeIssueList, {
      repository: this.options.repository,
      items,
      total: response.total ?? items.length,
      counts: { open: 0, closed: 0 },
      canCreate: false,
      unavailableReason: "Issue writes are not available through tea.",
      incomplete: true,
      truncated: more && q.page === 40,
      ...(more && q.page < 40 ? { nextPage: q.page + 1 } : {}),
    });
  }
  async issueDetail(number: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    const data = decode(issue, (await this.get(`/${number}`, signal)).body);
    if (data.number !== number) throw new ForgeError("invalid_data");
    return decode(ForgeIssueDetail, {
      ...this.row(data),
      body: clipText(data.body ?? ""),
      permissions: {
        edit: false,
        close: false,
        reopen: false,
        comment: false,
        triage: false,
        reason: "Issue writes are not available through tea.",
      },
      relatedThreads: [],
      relatedThreadsTruncated: false,
    });
  }
  async issueTimeline(number: number, page: number, signal: AbortSignal) {
    z.number().int().positive().parse(number);
    z.number().int().min(1).max(120).parse(page);
    // The issue endpoint can also name PRs. Verify the resource before reading its timeline.
    await this.issueDetail(number, signal);
    const response = await this.get(`/${number}/timeline?page=${page}&limit=25`, signal);
    const data = decode(z.array(event).max(25), response.body);
    const more = response.total === undefined ? data.length === 25 : page * 25 < response.total;
    return {
      events: data.map((e) =>
        decode(ForgeIssueEvent, {
          id: String(e.id),
          kind: e.type === "comment" ? "issue_comment" : "activity",
          event: clipText(e.type),
          actor: clipText(e.user?.login ?? ""),
          at: e.created_at ?? null,
          ...(e.body !== undefined ? { body: clipText(e.body) } : {}),
          raw: redactData(e),
        }),
      ),
      ...(more && page < 120 ? { nextPage: page + 1 } : {}),
      truncated: more && page === 120,
    };
  }
}
