import { z } from "zod";
import { ForgeIssueWrite } from "@ace/protocol/forge-issues";
import type { ForgeRepository } from "@ace/protocol/forge";
import type { CommandRunner } from "./command.ts";
import type { WriteDispatch } from "./write-dispatch.ts";
import type { HostApiWrite } from "./read-only-api.ts";
import { TeaIssues } from "./tea-issues.ts";
import { teaGet, teaWrite } from "./tea-api.ts";
import { decode } from "./tea-records.ts";
import { ForgeError } from "./errors.ts";
import { planIssueWrite, issueWriteLanded, applyMembers } from "./issue-write-plan.ts";

export const teaIssueWrites: readonly HostApiWrite[] = [
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues$/ },
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues\/[1-9]\d*\/comments$/ },
  { method: "PATCH", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues\/[1-9]\d*$/ },
  { method: "POST", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues\/[1-9]\d*\/labels$/ },
  { method: "DELETE", endpoint: /^repos\/[^/?]+\/[^/?]+\/issues\/[1-9]\d*\/labels\/[1-9]\d*$/ },
];
const settings = z.object({
  archived: z.boolean(),
  has_issues: z.boolean(),
  permissions: z.object({ push: z.boolean() }),
});
const marked = z.looseObject({
  number: z.number().int().positive().optional(),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
const marker = (id: string) =>
  `<!-- ace-issue-action:${encodeURIComponent(z.string().min(1).max(256).parse(id))} -->`;

const Created = z.object({ id: z.number().int().positive() });
const RepoLabels = z
  .array(z.object({ id: z.number().int().positive(), name: z.string() }))
  .max(1000);
const MarkedPage = z.array(marked).max(100);

/** The daemon journals these writes through the same durable IssueActions used by GitHub. */
export class TeaIssueWriter {
  private root: string;
  private issues: TeaIssues;
  constructor(privateOptions: {
    repository: ForgeRepository;
    runner: CommandRunner;
    login: string;
  }) {
    this.options = privateOptions;
    this.root = `repos/${encodeURIComponent(privateOptions.repository.owner)}/${encodeURIComponent(privateOptions.repository.name)}`;
    this.issues = new TeaIssues(privateOptions);
  }
  private options: { repository: ForgeRepository; runner: CommandRunner; login: string };
  private get(path: string, signal: AbortSignal) {
    return teaGet(this.options.runner, this.options.login, this.root + path, signal);
  }
  private write(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: object,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ) {
    return teaWrite(
      this.options.runner,
      this.options.login,
      this.root + path,
      method,
      body,
      signal,
      dispatch,
    );
  }
  async writeIssue(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
    dispatch?: WriteDispatch,
  ) {
    const value = ForgeIssueWrite.parse(input);
    const repo = decode(settings, (await this.get("", signal)).body);
    // Conservative permission policy: only repository writers mutate via tea.
    if (repo.archived || !repo.has_issues || !repo.permissions.push)
      throw new ForgeError("forbidden");
    if (value.action === "create") {
      const result = decode(
        marked,
        await this.write(
          "/issues",
          "POST",
          { title: value.title, body: `${value.body}\n\n${marker(actionId)}` },
          signal,
          dispatch,
        ),
      );
      if (!result.number || result.pull_request != null) throw new ForgeError("invalid_data");
      return { repository: this.options.repository, number: result.number };
    }
    const current = await this.issues.issueDetail(value.number, signal);
    if (value.action === "comment") {
      decode(
        Created,
        await this.write(
          `/issues/${value.number}/comments`,
          "POST",
          { body: `${value.body}\n\n${marker(actionId)}` },
          signal,
          dispatch,
        ),
      );
      return current.ref;
    }
    // Gitea has no GitHub state reason; never silently discard a requested reason.
    if (value.action === "state" && value.reason) throw new ForgeError("unsupported");
    const plan = planIssueWrite(
      {
        ...current,
        permissions: {
          edit: true,
          close: true,
          reopen: true,
          comment: true,
          triage: true,
          reason: "",
        },
      },
      value,
    );
    if (plan.kind === "conflict") throw new ForgeError("conflict");
    if (plan.kind === "forbidden") throw new ForgeError("forbidden");
    if (plan.kind === "done") return current.ref;
    if (plan.kind === "members") {
      if (plan.field === "assignees") {
        await this.write(
          `/issues/${value.number}`,
          "PATCH",
          { assignees: applyMembers(current.assignees, plan.add, plan.remove) },
          signal,
          dispatch,
        );
      } else {
        const response = await this.get("/labels?limit=1000&page=1", signal);
        const labels = decode(RepoLabels, response.body);
        if (response.total === undefined || response.total > labels.length)
          throw new ForgeError("limit");
        const id = (name: string) => {
          const found = labels.find((l) => l.name === name);
          if (!found) throw new ForgeError("not_found");
          return found.id;
        };
        const add = plan.add.map(id),
          remove = plan.remove.map(id);
        // Multi-call writes remain uncertain after any first dispatch, even if a later call fails.
        if (add.length)
          await this.write(
            `/issues/${value.number}/labels`,
            "POST",
            { labels: add },
            signal,
            dispatch,
          );
        for (const label of remove)
          await this.write(
            `/issues/${value.number}/labels/${label}`,
            "DELETE",
            {},
            signal,
            add.length || label !== remove[0] ? undefined : dispatch,
          );
      }
    } else {
      const body = { ...plan.body };
      delete body.state_reason;
      await this.write(`/issues/${value.number}`, "PATCH", body, signal, dispatch);
    }
    return current.ref;
  }
  listIssues(...args: Parameters<TeaIssues["listIssues"]>) {
    return this.issues.listIssues(...args);
  }
  issueDetail(...args: Parameters<TeaIssues["issueDetail"]>) {
    return this.issues.issueDetail(...args);
  }
  issueTimeline(...args: Parameters<TeaIssues["issueTimeline"]>) {
    return this.issues.issueTimeline(...args);
  }
  async reconcileIssue(input: ForgeIssueWrite, actionId: string, signal: AbortSignal) {
    const value = ForgeIssueWrite.parse(input);
    if (value.action !== "create" && value.action !== "comment") {
      const current = await this.issues.issueDetail(value.number, signal);
      return issueWriteLanded(current, value) ? current.ref : null;
    }
    if (value.action === "comment") await this.issues.issueDetail(value.number, signal);
    for (let page = 1; page <= 10; page++) {
      const response = await this.get(
        value.action === "create"
          ? `/issues?state=all&type=issues&limit=100&page=${page}`
          : `/issues/${value.number}/comments?limit=100&page=${page}`,
        signal,
      );
      const rows = decode(MarkedPage, response.body);
      const found = rows.find(
        (row) => row.pull_request == null && row.body?.includes(marker(actionId)),
      );
      const number = value.action === "comment" ? value.number : found?.number;
      if (found && number) return { repository: this.options.repository, number };
      if (response.total !== undefined ? page * 100 >= response.total : rows.length < 100)
        return null;
    }
    // A bounded, incomplete traversal cannot prove a write absent.
    throw new ForgeError("limit");
  }
}
