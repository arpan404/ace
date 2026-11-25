import { merge3 } from "@ace/editor";
import { CheckoutError, diffTexts, fold } from "@ace/ui-core";
import { mobilePageLimits, unifiedPage } from "@ace/ui-core/mobile";

export function compareDraft(disk: string, draft: string) {
  const lines = disk === draft ? [] : diffTexts(disk, draft);
  const rows = lines.some((line) => line.kind !== "context") ? fold(lines) : [];
  // The draft and disk reads are already bounded. Keep complete lines for the review.
  return {
    rows: unifiedPage(rows, 0, rows.length, {
      ...mobilePageLimits,
      lineLength: Math.max(disk.length, draft.length),
    }),
    finalNewlineChanged: disk.endsWith("\n") !== draft.endsWith("\n"),
  };
}

export async function mergeDraft(base: string, draft: string, disk: string) {
  try {
    const { prepareCheckoutEditor } = await import("./checkout-editor-wasm.ts");
    await prepareCheckoutEditor();
    return merge3(base, draft, disk).chunks;
  } catch {
    throw new CheckoutError("merge", "Couldn't merge the file. Try again.");
  }
}
