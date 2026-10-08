import type { SdkModule } from "./runtime-boundary.ts";
import { fileURLToPath } from "node:url";
import { ProviderApiKey } from "@ace/protocol";

export function cursorApiKeyEntry(): string {
  return fileURLToPath(new URL("./api-key-entry.ts", import.meta.url));
}
/** Runs only inside the isolated SDK worker. The SDK owns serialization and file permissions. */
export async function saveCursorApiKey(
  key: Buffer,
  boundary: {
    sdk: Pick<SdkModule, "FileCredentialStore">;
    backendUrl: string;
    now(): number;
  },
): Promise<void> {
  let apiKey = "";
  try {
    apiKey = ProviderApiKey.parse(key.toString("utf8").trimEnd());
    await new boundary.sdk.FileCredentialStore().save({
      version: 1,
      backendUrl: boundary.backendUrl,
      apiKey,
      createdAtMs: boundary.now(),
    });
  } finally {
    key.fill(0);
    apiKey = "";
  }
}
