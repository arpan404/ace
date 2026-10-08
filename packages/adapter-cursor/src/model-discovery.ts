import type { SdkModule } from "./runtime-boundary.ts";
import { discoveryFailureCode, discoveryFailureReason } from "@ace/provider-kit/discovery-failure";

/** The SDK owns credential access; only state and scrubbed discovery diagnostics escape. */
export async function cursorModelsInHost(
  sdk: { Cursor: Pick<SdkModule["Cursor"], "auth" | "models"> },
  environmentKeyUsable: boolean | undefined,
): Promise<unknown> {
  try {
    if (
      environmentKeyUsable === false ||
      (environmentKeyUsable === undefined &&
        (await sdk.Cursor.auth.status()).status !== "logged-in")
    )
      throw Object.assign(new Error("Cursor SDK is not configured"), { code: "not_configured" });
    return await sdk.Cursor.models.list();
  } catch (error) {
    const code = discoveryFailureCode(error);
    throw Object.assign(new Error("Cursor SDK model discovery failed"), {
      code,
      ...(code === "discovery_failed" ? { detail: discoveryFailureReason(error) } : {}),
    });
  }
}
