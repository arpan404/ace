import { createHash, randomBytes } from "node:crypto";
import { ShareTemplateDraft } from "@ace/protocol/marketplace";
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
    operation: "authorize" | "begin" | "published",
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
        path: `/v1/share-templates/${encodeURIComponent(id)}/${operation}`,
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
  return {
    async authorize(id, review) {
      return ShareTemplateDraft.parse(await stamped(id, "authorize", review));
    },
    async begin(id, review, draft, binding) {
      await stamped(id, "begin", { review, draft, binding });
    },
    async published(id, binding) {
      await stamped(id, "published", binding);
    },
  };
}
