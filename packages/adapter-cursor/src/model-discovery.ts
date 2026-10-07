import type { SdkModule } from "./runtime-boundary.ts";
import { discoveryFailureCode } from "@ace/provider-kit/discovery-failure";

/** The SDK owns credential access. Only its sign-in state and fixed error codes escape. */
export async function cursorModelsInHost(
  sdk: { Cursor: Pick<SdkModule["Cursor"], "auth" | "models"> },
  environmentKeyUsable: boolean | undefined,
): Promise<unknown> {
  try {
    const status = await sdk.Cursor.auth.status();
    if (
      environmentKeyUsable === false ||
      (environmentKeyUsable === undefined && status.status !== "logged-in")
    )
      throw Object.assign(new Error("Cursor SDK is not configured"), { code: "not_configured" });
    return await sdk.Cursor.models.list();
  } catch (error) {
    throw Object.assign(new Error("Cursor SDK model discovery failed"), {
      code: discoveryFailureCode(error),
    });
  }
}
