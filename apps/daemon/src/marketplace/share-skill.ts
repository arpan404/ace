import { credentialFile, writeArchive } from "@ace/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import { hiddenFileFindings } from "@ace/marketplace/scan";
import { templateMarketCall } from "@ace/client/market-intent";
import {
  PublishAccepted,
  type MarketOperation,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { marketError as error } from "./market-error.ts";
import { entryNameOf, readPicked, type PickPorts } from "./pick.ts";
import { privateText, type TemplatePort } from "./publish-template.ts";
import { publishAction, workerError } from "./publish.ts";

type Operation = Extract<MarketOperation, { op: "shareSkill" }>;

export async function shareSkill(
  operation: Operation,
  pick: PickPorts,
  privacy: NonNullable<TemplatePort["scanSkill"]>,
  market: Parameters<typeof publishAction>[0],
  names: readonly string[],
): Promise<MarketResult> {
  if (!market.http || !names[0]?.trim() || !names[1]?.includes("@"))
    return error("signed_out", "Sign in to ace to check the skill against your identity.");
  const type = "spade-skill";
  const version = "1.0.0";
  const visibility = "unlisted";
  const picked = await readPicked(pick, type, operation.source);
  if (picked?.kind !== "files" || !picked.picked)
    return error("not_found", "This skill is no longer in your library.");
  if (picked.excluded.length)
    return error("invalid", "Remove files that can't be reviewed from the skill before sharing.");
  const name = entryNameOf(picked.picked, "");
  const checked = checkFiles(type, name, picked.files);
  if (checked.problems.length)
    return error("invalid", checked.problems[0]?.message ?? "The skill cannot be packaged.");
  const files = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of checked.files) {
    let text: string;
    try {
      text = decoder.decode(file.content);
    } catch {
      return error("invalid", "Every file in a shared skill must be readable as text.");
    }
    if (
      text.includes("\0") ||
      credentialFile(file.path.split("/").at(-1) ?? "") ||
      privateText([file.path, text], names) ||
      hiddenFileFindings(file.path, text).some(({ level }) => level === "block")
    )
      return error("invalid", "The skill contains private or hidden text.");
    files.push({ path: file.path, text, executable: file.executable });
  }
  const { hash } = checked;
  if (operation.reviewed !== undefined && operation.reviewed !== hash)
    return error("conflict", "The skill changed. Review its files again.");
  const texts = files.flatMap(({ path, text }) => [path, text]);
  await privacy(texts);
  if (!operation.reviewed) return { op: "skillShareReview", name, hash, files };

  const ask = (action: Parameters<typeof publishAction>[1]) => publishAction(market, action);
  const mine = await ask({ action: "me" });
  if (mine.op !== "publish" || mine.answer.kind !== "me") return mine;
  const publisher = mine.answer.me.profile?.id;
  if (!publisher) return error("conflict", "Make your publisher profile before sharing.");
  const existing = await ask({ action: "entry", type, name });
  if (existing.op === "publish" && existing.answer.kind === "entry") {
    const { summary, versions } = existing.answer.entry;
    if (
      summary.visibility === visibility &&
      summary.shareId &&
      versions.some(
        (row) =>
          row.hash === hash &&
          row.version === version &&
          row.status !== "blocked" &&
          row.status !== "withdrawn",
      )
    )
      return { op: "skillShared", id: summary.shareId };
    return error("conflict", "This skill name already has a different publication.");
  }
  if (existing.op !== "error" || existing.code !== "not_found") return existing;
  const draft = mine.answer.me.drafts.find(
    (row) => row.type === type && row.name === name && row.version === version && row.hash === hash,
  );
  const result = draft
    ? await ask({ action: "draftRead", id: draft.id })
    : await publishAction(
        { ...market, archive: writeArchive(checked.files) },
        { action: "draftCreate", type, name, version, source: { kind: "archive", archive: "" } },
      );
  if (result.op !== "publish" || result.answer.kind !== "draft") return result;
  if (result.answer.draft.hash !== hash)
    return error("conflict", "The reviewed skill changed before sharing.");
  if (result.answer.draft.scan.state === "scanning")
    return error("conflict", "The Store is still scanning the skill. Try again shortly.");
  const target = {
    draft: result.answer.draft.id,
    name,
    version,
    hash,
    publisher,
    visibility,
  } as const;
  if (!market.personGrant) return { op: "templateGrant", target };
  await privacy(texts);
  const call = templateMarketCall(target);
  const reply = await market.http.send(call.method, call.path, {
    headers: { authorization: `Bearer ${market.personGrant}` },
  });
  if (reply.status < 200 || reply.status >= 300) return workerError(reply.status, reply.body);
  const accepted = PublishAccepted.safeParse(reply.body);
  if (
    !accepted.success ||
    accepted.data.type !== type ||
    accepted.data.name !== name ||
    accepted.data.version !== version ||
    accepted.data.hash !== hash ||
    accepted.data.visibility !== visibility ||
    !accepted.data.shareId
  )
    return error("conflict", "The Store answered for a different skill version or visibility.");
  const confirmed = await ask({ action: "entry", type, name });
  if (
    confirmed.op !== "publish" ||
    confirmed.answer.kind !== "entry" ||
    confirmed.answer.entry.summary.visibility !== visibility ||
    confirmed.answer.entry.summary.shareId !== accepted.data.shareId ||
    !confirmed.answer.entry.versions.some(
      (row) =>
        row.version === version &&
        row.hash === hash &&
        row.status !== "blocked" &&
        row.status !== "withdrawn",
    )
  )
    return error("conflict", "The Store has not confirmed the reviewed skill.");
  return { op: "skillShared", id: accepted.data.shareId };
}
