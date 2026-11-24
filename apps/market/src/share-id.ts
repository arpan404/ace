/** UUIDv7 with 74 independent random bits. */
export function shareId(now: number, bytes: Uint8Array): string {
  const timestamp = now.toString(16).padStart(12, "0");
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const variant = (8 | ((bytes[2] ?? 0) & 3)).toString(16);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${hex.slice(1, 4)}-${variant}${hex.slice(5, 8)}-${hex.slice(8)}`;
}

export const shareable = (type: string) => type === "spade-bot" || type === "spade-skill";
