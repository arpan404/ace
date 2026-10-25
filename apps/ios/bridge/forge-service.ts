import { ClientError } from "@ace/client";
import { actionErrorText } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeIssueRequest, readIssue } from "./forge-issue.ts";
import { ForgeListRequest, readIssues, readPulls } from "./forge-lists.ts";
import { ForgePullRequest, readPull, writePull } from "./forge-pull.ts";
import { ForgeReads, ForgeRefusal, type ForgeMemory, type ForgeOwner } from "./forge-reads.ts";
import { ForgeFileRequest, ForgeFilesRequest, readFile, readFiles } from "./forge-code.ts";
import {
  complete,
  ForgeCompleteRequest,
  ForgeReviewersRequest,
  readReviewers,
} from "./forge-people.ts";
import type { ShownBodies } from "./forge-conversation.ts";
import { ForgeReviewRequest, writeReview } from "./forge-review-write.ts";
import { ForgeInboxRequest, ForgeInboxWriteRequest, readInbox, writeInbox } from "./forge-inbox.ts";
import { ForgeTimelineRequest, readTimeline } from "./forge-timeline.ts";

/*
 * The phone's Pull requests and Issues as native service calls: Swift asks for a list, a page
 * or a write with the person's choices; this answers with what to draw, decided by the web's
 * shared rules. `fresh` (pull to refresh) reads GitHub again instead of the remembered lists.
 */

export const ForgeRequest = z.intersection(
  z.union([
    z.object({ type: z.literal("forge.projects") }),
    ForgeListRequest,
    ForgePullRequest,
    ForgeIssueRequest,
    ForgeTimelineRequest,
    ForgeFileRequest,
    ForgeFilesRequest,
    ForgeReviewRequest,
    ForgeCompleteRequest,
    ForgeReviewersRequest,
    ForgeInboxRequest,
    ForgeInboxWriteRequest,
  ]),
  z.object({ fresh: z.boolean().default(false) }),
);
export type ForgeRequest = z.infer<typeof ForgeRequest>;

export interface ProjectsReply {
  type: "forge.projects";
  projects: { id: string; name: string }[];
}

export class ForgeService {
  #owner: ForgeOwner;
  #preview: Preview;
  #now: () => number;
  #stamp: () => string;
  #newId: () => string;
  #cache = new Map<string, ForgeMemory>();
  /** Comment bodies as last shown, which an edit or delete expects to replace. */
  #shown: ShownBodies = new Map();

  /**
   * `stamp` is the kept forge reads' stamp (`NativeReads.stamp`), so both memories agree;
   * `newId` names a pending review comment.
   */
  constructor(
    owner: ForgeOwner,
    preview: Preview,
    now: () => number,
    stamp: () => string,
    newId: () => string,
  ) {
    this.#owner = owner;
    this.#preview = preview;
    this.#now = now;
    this.#stamp = stamp;
    this.#newId = newId;
  }

  /**
   * The answer to one request. A refusal throws with the web's sentence for it; a write's
   * outcome, refused or not, is an answer of its own (`ok`, `message`).
   */
  async answer(request: ForgeRequest, signal: AbortSignal): Promise<unknown> {
    const reads = new ForgeReads(
      this.#owner,
      this.#now,
      this.#cache,
      signal,
      request.fresh,
      this.#stamp(),
    );
    try {
      switch (request.type) {
        case "forge.projects":
          return await this.#projects(signal);
        case "forge.pulls":
          return await readPulls(reads, request, this.#preview);
        case "forge.issues":
          return await readIssues(reads, request, this.#preview);
        case "forge.pull":
          return await readPull(reads, request, this.#preview);
        case "forge.issue":
          return await readIssue(reads, request, this.#preview);
        case "forge.merge":
        case "forge.auto-merge":
          return { type: "forge.write", ...(await writePull(this.#owner, reads, request)) };
        case "forge.pull.timeline":
          return this.#trimmed(await readTimeline(reads, request, this.#preview, this.#shown));
        case "forge.pull.file":
          return this.#trimmed(await readFile(reads, request, this.#preview, this.#shown));
        case "forge.pull.files":
          return await readFiles(reads, request, this.#preview);
        case "forge.complete":
          return await complete(reads, request, this.#preview);
        case "forge.pull.reviewers":
          return await readReviewers(reads, request, this.#preview);
        case "forge.inbox":
          return await readInbox(reads, request, this.#preview);
        case "forge.inbox.write":
          return await writeInbox(this.#owner, reads, request);
        case "forge.review":
          return await writeReview(this.#owner, reads, request, this.#shown, this.#newId);
      }
    } catch (error) {
      const code =
        error instanceof ForgeRefusal || error instanceof ClientError ? error.code : undefined;
      throw new Error(actionErrorText(code), { cause: error });
    }
  }

  /** The oldest shown bodies go once the memory holds more than a few long pages' worth. */
  #trimmed<T>(reply: T): T {
    for (const key of this.#shown.keys()) {
      if (this.#shown.size <= 4_000) break;
      this.#shown.delete(key);
    }
    return reply;
  }

  /** The machine's projects, read as New thread reads them (`workspaces.list`). */
  async #projects(signal: AbortSignal): Promise<ProjectsReply> {
    const projects: { id: string; name: string }[] = [];
    let after: string | undefined;
    do {
      const reply = await this.#owner.request(
        {
          type: "workspace.request",
          operation: { op: "workspaces.list", limit: 100, ...(after ? { after } : {}) },
        },
        { signal, timeoutMs: 15_000 },
      );
      if (reply.result.kind === "error") throw new ForgeRefusal(reply.result.code);
      if (reply.result.kind !== "workspaces") throw new ForgeRefusal("forge_invalid_data");
      for (const project of reply.result.workspaces)
        // A chat's hidden project has no repository (ADR 0099).
        if (project.kind !== "chat")
          projects.push({ id: project.id, name: this.#preview(project.name, 200) });
      after = reply.result.next;
    } while (after && projects.length < 300);
    return { type: "forge.projects", projects };
  }
}
