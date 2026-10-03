import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { validatePrivateDirectory } from "./checkpoints.ts";

/** Reject cross-home redirects before SDK import; never read the credential's contents. */
export async function validateCursorAuthHome(home: string, maxBytes = 65536): Promise<void> {
  const root = join(home, ".cursor", "sdk");
  await validatePrivateDirectory(root);
  try {
    const stat = await lstat(join(root, "auth.json"));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
      throw new Error(
        "SDK credential store is redirected, unsafe or oversized; repair it in the selected home",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
