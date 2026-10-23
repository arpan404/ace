import { z } from "zod";
import type { ForgeReviewAction, ForgeReviewAnchor } from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { validHostedAnchor } from "./review-anchor.ts";
import { decode, type ReviewIo } from "./review-io.ts";

type LineComment = Extract<ForgeReviewAction, { kind: "line.comment" }>;
type HostPr = { state: string; headRefOid: string; viewerCanComment: boolean };
const text = z.string().max(65_536);
const Inline = z.looseObject({
  id: z.number().int().positive(),
  body: text,
  path: text.optional(),
  user: z.looseObject({ login: text }).nullable(),
});

/** Every anchor must name a line GitHub's own patch for the PR draws, never a local worktree's. */
export async function assertHostedAnchors(
  io: ReviewIo,
  number: number,
  anchors: ForgeReviewAnchor[],
  signal: AbortSignal,
): Promise<void> {
  const files = await io.records(
    `${io.root}/pulls/${number}/files?per_page=100`,
    z.looseObject({ filename: text, patch: z.string().max(4_194_304).optional() }),
    signal,
  );
  for (const anchor of anchors) {
    const patch = files.find((f) => f.filename === anchor.path)?.patch;
    if (!patch || !validHostedAnchor(patch, anchor)) throw new ForgeError("conflict");
  }
}

/** The GitHub REST coordinates of an anchor; a single line sends no start. */
export function anchorCoordinates(anchor: ForgeReviewAnchor) {
  return {
    path: anchor.path,
    line: anchor.line,
    side: anchor.side,
    ...(anchor.startLine === undefined
      ? {}
      : { start_line: anchor.startLine, start_side: anchor.startSide ?? anchor.side }),
  };
}

/**
 * One inline comment posted on its own. It never opens, joins or submits a review, so the
 * viewer's pending drafts stay unsent.
 */
export class GitHubLineComment {
  readonly #io: ReviewIo;
  constructor(io: ReviewIo) {
    this.#io = io;
  }
  async write(
    number: number,
    action: LineComment,
    host: { pr: HostPr },
    reread: () => Promise<{ pr: HostPr }>,
    marker: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<void> {
    const current = host.pr;
    if (current.state !== "OPEN" || current.headRefOid !== action.headSha)
      throw new ForgeError("conflict");
    if (!current.viewerCanComment) throw new ForgeError("forbidden");
    if (action.anchor.commit !== action.headSha) throw new ForgeError("conflict");
    await assertHostedAnchors(this.#io, number, [action.anchor], signal);
    // The patch read takes time; the head must still be the one the anchor was checked against.
    const latest = (await reread()).pr;
    if (latest.state !== "OPEN" || latest.headRefOid !== action.headSha)
      throw new ForgeError("conflict");
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    const response = await this.#io.request(
      `${this.#io.root}/pulls/${number}/comments`,
      signal,
      {
        commit_id: action.headSha,
        ...anchorCoordinates(action.anchor),
        body: `${action.body}\n\n${marker}`,
      },
      "POST",
      dispatch,
    );
    decode(Inline, response.body);
  }
  /** Posted when the viewer's inline comment on that path carries this write's marker. */
  async reconcile(
    number: number,
    action: LineComment,
    viewer: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const comments = await this.#io.records(
      `${this.#io.root}/pulls/${number}/comments?per_page=100`,
      Inline,
      signal,
    );
    return comments.some(
      (c) => c.user?.login === viewer && c.body.includes(marker) && c.path === action.anchor.path,
    );
  }
}
