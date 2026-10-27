import {
  ForgeRepository,
  type ForgeFile,
  type ForgeFileContent,
  type ForgeImageType,
} from "@ace/protocol";
import { blockDiff, hostedImageType, markdownBlocks } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { FileRevisions, findFile } from "./forge-code.ts";
import { ForgeRange } from "./forge-commits.ts";
import { prDetail } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeReads } from "./forge-reads.ts";
import { repositoryBlocks, type RichBlock } from "./forge-rich.ts";

/*
 * A changed file read whole on both sides, for what its patch can't show well: a Markdown
 * document drawn as it reads, each block kept, removed or added (the web's rendered diff, by
 * the same block rule), and an image's two versions. Both sides come through the daemon
 * (`forge.file.content`), never from GitHub directly; content at a commit never changes.
 */

export const ForgeFileSidesRequest = z.object({
  type: z.literal("forge.pull.file.sides"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  path: z.string().min(1).max(4096),
  index: z.number().int().nonnegative().max(100_000).optional(),
  range: ForgeRange.optional(),
  /** `rendered`: the Markdown blocks diff; `image`: both images. */
  as: z.enum(["rendered", "image"]),
  /**
   * The commits the page's diff showed: both sides are read at exactly these, so what is drawn
   * matches the version a Viewed mark names. Without them, the PR's head now.
   */
  revisions: FileRevisions.optional(),
});
export type ForgeFileSidesRequest = z.infer<typeof ForgeFileSidesRequest>;

/** One side of an image: its bytes (base64) and size, or why it can't be drawn. */
export type ImageSide =
  | { state: "image"; mimeType: string; data: string; size: number }
  | { state: "none" }
  | { state: "unavailable"; reason: string };

export type SidesReply =
  | {
      type: "forge.pull.file.sides";
      as: "rendered";
      blocks: { kind: "same" | "del" | "add"; blocks: RichBlock[] }[];
      /** Blocks past the phone's budget; the rest read on GitHub. */
      hidden: number;
      /** The commits drawn. */
      revisions: FileRevisions;
    }
  | {
      type: "forge.pull.file.sides";
      as: "image";
      before: ImageSide;
      after: ImageSide;
      revisions: FileRevisions;
    };

/** The most blocks a rendered diff draws, and the most text it reads per side. */
const blockBudget = 400;
const textPages = 16;

/** Why a side can't be drawn, in words. */
const sideReason = (content: ForgeFileContent): string =>
  content.kind === "large"
    ? "Too large to show here"
    : content.kind === "binary"
      ? "Not an image this phone can draw"
      : "Can't be shown here";

async function readSide(
  reads: ForgeReads,
  request: ForgeFileSidesRequest,
  side: { sha: string; path: string },
  image: ForgeImageType | undefined,
): Promise<ForgeFileContent | { kind: "text"; text: string; size: number }> {
  let text = "";
  for (let page = 1; page <= textPages;) {
    const value = await reads.read(
      {
        op: "forge.file.content",
        workspaceId: request.project,
        ...(request.repository ? { repository: request.repository } : {}),
        sha: side.sha,
        path: side.path,
        page,
        ...(image ? { image } : {}),
      },
      true,
    );
    if (value.resource !== "fileContent") throw new ForgeRefusal("forge_invalid_data");
    const content = value.value;
    if (content.kind !== "text") return content;
    text += content.text;
    if (!content.nextPage) return { kind: "text", text, size: content.size };
    page = content.nextPage;
  }
  return { kind: "large", size: text.length };
}

/** The two reads a file needs; a side the change has no file on is missing. */
const sidesOf = (revisions: FileRevisions) => ({
  base:
    revisions.status === "added"
      ? undefined
      : { sha: revisions.base, path: revisions.previousPath ?? revisions.path },
  head: revisions.status === "removed" ? undefined : { sha: revisions.head, path: revisions.path },
});

/** The commits to read: the ones asked for, else the file's diff at the PR's head now. */
async function revisionsOf(
  reads: ForgeReads,
  request: ForgeFileSidesRequest,
  detail: { status: { headSha: string }; baseSha: string },
): Promise<{ revisions: FileRevisions; path: string }> {
  if (request.revisions) return { revisions: request.revisions, path: request.revisions.path };
  const found = await findFile(reads, request, {
    headSha: detail.status.headSha,
    baseSha: detail.baseSha,
  });
  const file: ForgeFile = found.file;
  return {
    path: file.path,
    revisions: {
      base: found.baseSha,
      head: found.headSha,
      prHead: detail.status.headSha,
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
    },
  };
}

/** A side read as text: an added or removed file has none. */
const textOf = (content: ForgeFileContent) => {
  if (content.kind === "text") return content.text;
  if (content.kind === "missing") return "";
  throw new ForgeRefusal("forge_unsupported");
};

export async function readFileSides(
  reads: ForgeReads,
  request: ForgeFileSidesRequest,
  preview: Preview,
): Promise<SidesReply> {
  const detail = await prDetail(reads, request);
  const { revisions, path } = await revisionsOf(reads, request, detail);
  const sides = sidesOf(revisions);
  const image = request.as === "image" ? hostedImageType(path) : undefined;
  if (request.as === "image" && !image) throw new ForgeRefusal("forge_unsupported");
  const missing = { kind: "missing" } as const;
  const [before, after] = await Promise.all(
    [sides.base, sides.head].map((side) =>
      side ? readSide(reads, request, side, image) : Promise.resolve(missing),
    ),
  );
  if (!before || !after) throw new ForgeRefusal("forge_invalid_data");
  if (request.as === "image") {
    const shown = (content: ForgeFileContent): ImageSide =>
      content.kind === "image"
        ? { state: "image", mimeType: content.type, data: content.data, size: content.size }
        : content.kind === "missing"
          ? { state: "none" }
          : { state: "unavailable", reason: sideReason(content) };
    return {
      type: "forge.pull.file.sides",
      as: "image",
      before: shown(before),
      after: shown(after),
      revisions,
    };
  }
  const repository = detail.status.ref.repository;
  const changes = blockDiff(
    markdownBlocks(textOf(before)),
    markdownBlocks(textOf(after)),
    (b) => b,
  );
  return {
    type: "forge.pull.file.sides",
    as: "rendered",
    blocks: changes.slice(0, blockBudget).map((change) => ({
      kind: change.kind,
      blocks: repositoryBlocks(preview(change.item, 16_384), repository),
    })),
    hidden: Math.max(0, changes.length - blockBudget),
    revisions,
  };
}
