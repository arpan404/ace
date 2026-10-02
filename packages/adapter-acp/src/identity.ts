/** Persist generation and cursor together when continuing an allocator after a restart. */
export interface TranslatorIdentity {
  generation: string;
  cursor: number;
}
export function createTranslatorIdentity(generation: string, cursor = 0): TranslatorIdentity {
  if (!generation || !Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid ACP identity allocation");
  return { generation, cursor };
}
