import { z } from "zod";
import type { ForgeStackOperation } from "@ace/protocol/forge-stacks";
const text = z.string().max(65_536);
const response = z.looseObject({
  status: text,
  details: z.looseObject({ uuid: z.uuid().optional(), message: text }),
});

/** Unknown successful result states remain observable as uncertain raw data. */
export function decodeStackMergeOperation(body: unknown): ForgeStackOperation | undefined {
  const result = response.safeParse(body);
  if (!result.success || (result.data.status === "pending" && !result.data.details.uuid))
    return undefined;
  return {
    action: "merge",
    raw: body,
    state:
      result.data.status === "pending" ||
      result.data.status === "merged" ||
      result.data.status === "enqueued" ||
      result.data.status === "failed"
        ? result.data.status
        : "uncertain",
    message: result.data.details.message,
    ...(result.data.details.uuid ? { uuid: result.data.details.uuid } : {}),
  };
}
