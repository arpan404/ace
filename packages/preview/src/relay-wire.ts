import { z } from "zod";

export const frameSize = 16_384;
export const windowSize = 262_144;
export const kinds = { open: 1, ready: 2, data: 3, credit: 4, end: 5, reset: 6 };
const Header = z.object({
  kind: z.number().int().min(1).max(6),
  id: z.number().int().min(1).max(0xffffffff),
  value: z.number().int().min(0).max(0xffffffff),
});
export type Frame = z.infer<typeof Header> & { data: Uint8Array };
export function decodeFrame(input: unknown): Frame {
  const bytes = z.instanceof(Uint8Array).parse(input);
  if (bytes.byteLength < 12 || bytes.byteLength > 12 + frameSize)
    throw new Error("Invalid relay frame size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== 1 || view.getUint16(2) !== 0) throw new Error("Invalid relay version");
  const frame = Header.parse({
    kind: view.getUint8(1),
    id: view.getUint32(4),
    value: view.getUint32(8),
  });
  const data = bytes.subarray(12);
  if (
    frame.kind === kinds.data
      ? data.byteLength !== frame.value || data.byteLength === 0
      : data.byteLength !== 0
  )
    throw new Error("Invalid relay payload");
  if (![kinds.open, kinds.data, kinds.credit].includes(frame.kind) && frame.value !== 0)
    throw new Error("Invalid relay control value");
  return { ...frame, data };
}
export function encodeFrame(kind: number, id: number, value = 0, data?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + (data?.byteLength ?? 0));
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, kind);
  view.setUint32(4, id);
  view.setUint32(8, value);
  if (data) bytes.set(data, 12);
  return bytes;
}
