import { z } from "zod";
import { AcpSession, ConfigOption } from "./native-schemas.ts";

const id = z.string().min(1).max(256);
const CursorModels = z
  .object({
    models: z
      .array(
        z
          .object({ value: id, name: id, configOptions: z.array(ConfigOption).max(64).optional() })
          .passthrough(),
      )
      .max(512),
  })
  .passthrough();
export function cursorSessionOptions(session: unknown, listing: unknown): unknown {
  const parsed = AcpSession.parse(session);
  const rows = CursorModels.parse(listing).models;
  const current =
    parsed.configOptions?.find((option) => option.id === "model" || option.category === "model")
      ?.currentValue ?? parsed.models?.currentModelId;
  return {
    ...parsed,
    configOptions: [
      ...(parsed.configOptions ?? []).filter(
        (option) => option.id !== "model" && option.category !== "model",
      ),
      { id: "model", category: "model", type: "select", currentValue: current, options: rows },
    ],
  };
}
/** provider-kit represents RPC errors as serialized native error objects. */
export function isMissingMethod(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    return z.object({ code: z.literal(-32601) }).safeParse(JSON.parse(error.message)).success;
  } catch {
    return false;
  }
}
