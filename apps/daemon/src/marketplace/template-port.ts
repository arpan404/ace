import { createHash, randomBytes } from "node:crypto";
import { ShareReviewItem, ShareTemplateDraft, SpadeReviewProof } from "@ace/protocol/marketplace";
import { spadeRequest, type SpadeConnection } from "../spade/forward.ts";
import { personHeader, personStamp } from "../spade/person-stamp.ts";
import type { TemplatePort } from "./publish-template.ts";

export function templatePort(input: {
  connection(): SpadeConnection | undefined;
  key(): Uint8Array | undefined;
  now(): number;
}): TemplatePort {
  async function stamped(
    id: string,
    operation:
      | "preview"
      | "authorize"
      | "begin"
      | "published"
      | "skill-privacy"
      | "attest"
      | "skill-attest",
    data: unknown,
  ) {
    const connection = input.connection();
    const key = input.key();
    if (!connection || !key) throw new Error("Spade isn't ready to share templates.");
    const body = Buffer.from(JSON.stringify(data));
    const hash = createHash("sha256").update(body).digest("hex");
    const target = { target: `template:${id}`, value: `${operation}:${hash}` };
    const answer = await spadeRequest(
      connection,
      {
        method: "POST",
        path:
          operation === "skill-privacy"
            ? "/v1/share-skills/privacy"
            : operation === "skill-attest"
              ? "/v1/share-skills/attest"
              : `/v1/share-templates/${encodeURIComponent(id)}/${operation}`,
        body,
        contentType: "application/json",
        headers: {
          [personHeader]: personStamp(key, target, input.now(), randomBytes(16).toString("hex")),
        },
      },
      { signal: AbortSignal.timeout(15_000), maxBytes: 2 * 1024 * 1024 },
    );
    if (answer.kind !== "response") throw new Error("The template is too large.");
    const response: unknown = JSON.parse(answer.body.toString("utf8"));
    if (answer.status !== 200) {
      const error = response && typeof response === "object" && Reflect.get(response, "error");
      throw new Error(typeof error === "string" ? error : "Spade refused the template.");
    }
    return response;
  }
  const proofOf = (response: unknown) =>
    SpadeReviewProof.parse(
      response && typeof response === "object" ? Reflect.get(response, "proof") : undefined,
    );
  return {
    async attestTemplate(id, review, target, recipe) {
      return proofOf(await stamped(id, "attest", { review, target, recipe }));
    },
    async attestSkill(target, files, acknowledged) {
      return proofOf(await stamped("skill", "skill-attest", { target, files, acknowledged }));
    },
    async preview(id, review) {
      const response = await stamped(id, "preview", review);
      const items =
        response && typeof response === "object" ? Reflect.get(response, "items") : undefined;
      return ShareReviewItem.array().max(5000).parse(items);
    },
    async authorize(id, review) {
      return ShareTemplateDraft.parse(await stamped(id, "authorize", review));
    },
    async begin(id, review, draft, binding) {
      await stamped(id, "begin", { review, draft, binding });
    },
    async scanSkill(texts) {
      await stamped("skill", "skill-privacy", texts);
    },
    async published(id, binding, shareId) {
      await stamped(id, "published", { ...binding, shareId });
    },
  };
}
