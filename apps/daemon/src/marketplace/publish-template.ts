import { credentialFile, privacySpans, writeArchive, type ArchiveFile } from "@ace/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import { PublishAccepted } from "@ace/protocol/marketplace";
import { templateMarketCall } from "@ace/client/market-intent";
import type {
  TemplateGrantTarget,
  MarketOperation,
  MarketOwnEntry,
  MarketResult,
  ShareTemplateDraft,
  ShareTemplateReview,
} from "@ace/protocol/marketplace";
import { publishAction, workerError } from "./publish.ts";
import { marketError } from "./market-error.ts";
import { hiddenFileFindings } from "@ace/marketplace/scan";

type Operation = Extract<MarketOperation, { op: "publishTemplate" }>;

export type TemplateBinding = Pick<TemplateGrantTarget, "hash" | "visibility" | "publisher"> & {
  revision: string;
};

export interface TemplatePort {
  attestTemplate?(
    id: string,
    review: ShareTemplateReview,
    target: TemplateGrantTarget,
    recipe: string,
  ): Promise<string>;
  attestSkill?(
    target: TemplateGrantTarget,
    files: readonly { path: string; text: string; executable: boolean }[],
    acknowledged: readonly string[],
  ): Promise<string>;
  preview?(
    id: string,
    review: ShareTemplateReview,
  ): Promise<Extract<MarketResult, { op: "templateReview" }>["items"]>;
  authorize(id: string, review: ShareTemplateReview): Promise<ShareTemplateDraft>;
  begin(
    id: string,
    review: ShareTemplateReview,
    draft: ShareTemplateDraft,
    binding: TemplateBinding,
  ): Promise<void>;
  scanSkill?(texts: readonly string[]): Promise<void>;
  published(id: string, binding: TemplateBinding, shareId?: string): Promise<void>;
}

function templateFiles(draft: ShareTemplateDraft): ArchiveFile[] {
  const encoder = new TextEncoder();
  return [
    { path: "bot.json", content: encoder.encode(JSON.stringify(draft.recipe)), executable: false },
    ...draft.skills.flatMap(({ reference, text, files }) => [
      { path: `${reference}/SKILL.md`, content: encoder.encode(text), executable: false },
      ...files.map((file) => ({
        path: `${reference}/${file.path}`,
        content: encoder.encode(file.text),
        executable: file.executable,
      })),
    ]),
    ...draft.surface_files.map(({ path, text, executable }) => ({
      path,
      content: encoder.encode(text),
      executable,
    })),
  ];
}

export function privateText(value: unknown, names: readonly string[]): boolean {
  if (typeof value === "string") return privacySpans(value, { names }).length > 0;
  return value !== null && typeof value === "object"
    ? Object.entries(value).some(
        ([key, child]) => privateText(key, names) || privateText(child, names),
      )
    : false;
}

function matchesListing(
  entry: MarketOwnEntry,
  name: string,
  version: string,
  { hash, visibility }: TemplateBinding,
): boolean {
  return (
    entry.summary.type === "spade-bot" &&
    entry.summary.name === name &&
    entry.summary.visibility === visibility &&
    (visibility !== "unlisted" || entry.summary.shareId !== undefined) &&
    entry.versions.some(
      (row) =>
        row.version === version &&
        row.hash === hash &&
        row.status !== "blocked" &&
        row.status !== "withdrawn",
    )
  );
}

export async function publishTemplate(
  port: TemplatePort,
  market: Parameters<typeof publishAction>[0],
  operation: Operation,
  names: readonly string[],
): Promise<MarketResult> {
  const { id, review } = operation;
  if (!market.http || !names[0]?.trim() || !names[1]?.includes("@"))
    return marketError("signed_out", "Sign in to ace to check the template against your identity.");
  if (
    privateText(
      [
        review.name,
        review.description,
        review.task,
        review.routines,
        review.notes,
        review.knowledge,
      ],
      names,
    )
  )
    return marketError("invalid", "The template contains private text. Remove it before sharing.");
  const draft = await port.authorize(id, review);
  const files = templateFiles(draft);
  if (
    privateText(draft.recipe, names) ||
    files.some(({ path, content }) => {
      const filename = path.split("/").at(-1) ?? "";
      const text = new TextDecoder().decode(content);
      return (
        credentialFile(filename) ||
        privateText(path, names) ||
        (path !== "bot.json" && privateText(text, names)) ||
        hiddenFileFindings(path, text).some(({ level }) => level === "block")
      );
    })
  )
    return marketError(
      "invalid",
      "The template contains private or hidden text. Remove it before sharing.",
    );

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
  const mine = await request({ action: "me" });
  if (mine.op !== "publish" || mine.answer.kind !== "me") return mine;
  const publisher = mine.answer.me.profile?.id;
  if (!publisher) return marketError("conflict", "Make your publisher profile before you publish.");
  const binding = { revision: review.revision, hash, visibility: review.visibility, publisher };
  await port.begin(id, review, draft, binding);
  const recover = await request({ action: "entry", type, name });
  if (recover.op === "publish" && recover.answer.kind === "entry") {
    if (!matchesListing(recover.answer.entry, name, version, binding))
      return marketError("conflict", "This template already has a different publication.");
    const { shareId } = recover.answer.entry.summary;
    await port.published(id, binding, shareId);
    return {
      op: "publishedTemplate",
      name,
      visibility: review.visibility,
      ...(shareId && { shareId }),
    };
  }
  if (recover.op === "error" && recover.code !== "not_found") return recover;

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
  const target = {
    draft: uploaded.id,
    name,
    version,
    hash,
    publisher,
    visibility: review.visibility,
  } as const;
  if (!port.attestTemplate)
    return marketError("unavailable", "Spade cannot attest to this review.");
  const proof = await port.attestTemplate(id, review, target, JSON.stringify(draft.recipe));
  const publication = { ...target, proof };
  if (!market.personGrant) return { op: "templateGrant", target: publication };
  // Check the source bot and its current private data again at handoff, including after a restart.
  await port.begin(id, review, draft, binding);
  const call = templateMarketCall(publication);
  const response = await market.http.send(call.method, call.path, {
    headers: { authorization: `Bearer ${market.personGrant}` },
  });
  if (response.status < 200 || response.status >= 300)
    return workerError(response.status, response.body);
  const result = PublishAccepted.safeParse(response.body);
  if (
    !result.success ||
    result.data.type !== type ||
    result.data.name !== name ||
    result.data.version !== version ||
    result.data.hash !== hash ||
    result.data.visibility !== review.visibility ||
    (review.visibility === "unlisted" && !result.data.shareId)
  )
    return marketError(
      "conflict",
      "The Store answered for a different template version or visibility.",
    );
  // Read the durable Store row too. A lost or misleading receipt cannot mark the card published.
  const confirmed = await request({ action: "entry", type, name });
  if (
    confirmed.op !== "publish" ||
    confirmed.answer.kind !== "entry" ||
    !matchesListing(confirmed.answer.entry, name, version, binding) ||
    confirmed.answer.entry.summary.shareId !== result.data.shareId
  )
    return marketError("conflict", "The Store has not confirmed the reviewed publication.");
  const { shareId } = result.data;
  await port.published(id, binding, shareId);
  return {
    op: "publishedTemplate",
    name,
    visibility: review.visibility,
    ...(shareId && { shareId }),
  };
}
