import { randomBytes, randomUUID } from "node:crypto";

export type EntropySource = (bytes: number) => Uint8Array;
export interface CredentialRuntime {
  id(): string;
  randomBytes: EntropySource;
}
export const systemCredentials: Readonly<CredentialRuntime> = { id: randomUUID, randomBytes };
export function generateSecret(entropy: EntropySource): string {
  const bytes = entropy(32);
  if (bytes.byteLength !== 32) throw new Error("Credential entropy source must return 32 bytes");
  return Buffer.from(bytes).toString("hex");
}
