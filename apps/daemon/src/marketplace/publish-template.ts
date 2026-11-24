import { privacySpans, writeArchive, type ArchiveFile } from "@ace/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import type {
  MarketOperation,
  MarketResult,
  ShareTemplateDraft,
  ShareTemplateReview,
} from "@ace/protocol/marketplace";
import { publishAction } from "./publish.ts";
import { marketError } from "./market-error.ts";
import { hiddenFileFindings } from "@ace/marketplace/scan";

type Operation = Extract<MarketOperation, { op: "publishTemplate" }>;

export interface TemplatePort {
  authorize(id: string, review: ShareTemplateReview): Promise<ShareTemplateDraft>;
  published(id: string, review: ShareTemplateReview, draft: ShareTemplateDraft): Promise<void>;
}

function templateFiles(draft: ShareTemplateDraft): ArchiveFile[] {
  const encoder = new TextEncoder();
  return [
    { path: "bot.json", content: encoder.encode(JSON.stringify(draft.recipe)), executable: false },
    ...draft.skills.map(({ reference, text }) => ({
      path: `${reference}/SKILL.md`,
      content: encoder.encode(text),
      executable: false,
    })),
  ];
}

function privateText(value: unknown, names: readonly string[]): boolean {
  if (typeof value === "string") return privacySpans(value, { names }).length > 0;
  return value !== null && typeof value === "object"
    ? Object.values(value).some((child) => privateText(child, names))
    : false;
}

export async function publishTemplate(
  port: TemplatePort,
  market: Parameters<typeof publishAction>[0],
  operation: Operation,
  names: readonly string[],
): Promise<MarketResult> {
  const { id, review } = operation;
  if (
    privateText(
      [review.name, review.description, review.task, review.routines, review.notes],
      names,
    )
  )
    return marketError("invalid", "The template contains private text. Remove it before sharing.");
  const draft = await port.authorize(id, review);
  if (
    privateText(draft.recipe, names) ||
    draft.skills.some(
      ({ reference, text }) =>
        privateText([reference, text], names) ||
        hiddenFileFindings(`${reference}/SKILL.md`, text).some(({ level }) => level === "block"),
    )
  )
    return marketError(
      "invalid",
      "The template contains private or hidden text. Remove it before sharing.",
    );

  const files = templateFiles(draft);
  const name = id.replaceAll("_", "-");
  const type = "spade-bot";
  const version = "1.0.0";
  const checked = checkFiles(type, name, files);
  if (checked.problems.length)
    return marketError(
      "invalid",
      checked.problems[0]?.message ?? "The template cannot be packaged.",
    );
  const { hash } = checked;
  const request = (action: Parameters<typeof publishAction>[1]) => publishAction(market, action);
  const recover = await request({ action: "entry", type, name });
  if (recover.op === "publish" && recover.answer.kind === "entry") {
    const { entry } = recover.answer;
    const prior = entry.versions.find((item) => item.version === version);
    if (prior?.hash !== hash || entry.summary.visibility !== review.visibility)
      return marketError("conflict", "This template already has a different publication.");
    await port.published(id, review, draft);
    return { op: "publishedTemplate", name, visibility: review.visibility };
  }
  if (recover.op === "error" && recover.code !== "not_found") return recover;

  const mine = await request({ action: "me" });
  if (mine.op !== "publish" || mine.answer.kind !== "me") return mine;
  const existing = mine.answer.me.drafts.find(
    (item) => item.type === type && item.name === name && item.version === version,
  );
  const archive = writeArchive(files);
  const source = { kind: "archive" as const, archive: "" };
  const staged =
    existing?.hash === hash
      ? await request({ action: "draftRead", id: existing.id })
      : await publishAction(
          { ...market, archive },
          existing
            ? { action: "draftUpdate", id: existing.id, source }
            : { action: "draftCreate", type, name, version, source },
        );
  if (staged.op !== "publish" || staged.answer.kind !== "draft") return staged;
  const uploaded = staged.answer.draft;
  if (uploaded.hash !== hash)
    return marketError("conflict", "The reviewed package changed before publishing.");
  if (uploaded.scan.state === "scanning")
    return marketError("conflict", "The Store is still scanning the template. Try again shortly.");
  const result = await publishAction(
    { ...market, templateReviewHash: hash },
    {
      action: "draftPublish",
      id: uploaded.id,
      ...(review.visibility === "unlisted" ? { visibility: "unlisted" } : {}),
    },
  );
  if (result.op !== "publish" || result.answer.kind !== "published") return result;
  if (
    result.answer.type !== type ||
    result.answer.name !== name ||
    result.answer.version !== version
  )
    return marketError("conflict", "The Store answered for a different template version.");
  await port.published(id, review, draft);
  return { op: "publishedTemplate", name, visibility: review.visibility };
}
