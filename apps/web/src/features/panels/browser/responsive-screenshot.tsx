import type { BrowserScreenshotSize } from "@ace/protocol";
import { useState } from "react";
import { revealer } from "@/boot/open-external.ts";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { PreviewSource } from "../sources.ts";
import { compositeScreenshots, copyImage } from "./screenshot-composite.ts";
import { reason } from "./use-browser-features.ts";

const choices: readonly { size: BrowserScreenshotSize; label: string; width: number }[] = [
  { size: "phone", label: "Phone", width: 390 },
  { size: "tablet", label: "Tablet", width: 768 },
  { size: "desktop", label: "Desktop", width: 1440 },
];

/**
 * "Screenshot at sizes…": the tab's page laid out at phone, tablet and desktop widths in one
 * action. Each capture is kept in the thread's files; the set, side by side, goes to the
 * clipboard as one image.
 */
export function ResponsiveScreenshotDialog(props: {
  source: PreviewSource;
  threadId: string;
  tabId: string;
  onClose(): void;
}) {
  const toast = useToast();
  const [sizes, setSizes] = useState<ReadonlySet<BrowserScreenshotSize>>(
    () => new Set(choices.map((choice) => choice.size)),
  );
  const [fullPage, setFullPage] = useState(false);
  const [busy, setBusy] = useState(false);
  const capture = props.source.screenshotSizes;
  const take = async () => {
    if (!capture) return;
    setBusy(true);
    try {
      const picked = choices.filter((choice) => sizes.has(choice.size)).map((each) => each.size);
      const set = await capture(props.threadId, props.tabId, picked, fullPage);
      const composite = await compositeScreenshots(set.images).catch(() => undefined);
      const copied = composite ? await copyImage(composite) : false;
      const reveal = revealer();
      const first = set.images.find((image) => image.path)?.path;
      toast.add({
        title:
          set.images.length === 1
            ? "Screenshot saved to this thread"
            : `${set.images.length} screenshots saved to this thread`,
        description: copied ? "Copied side by side to the clipboard" : undefined,
        ...(reveal && first
          ? {
              actionProps: {
                children: "Show in Finder",
                onClick: () => void reveal(first).catch(() => {}),
              },
            }
          : {}),
      });
      props.onClose();
    } catch (error) {
      toast.error({ title: "Couldn't take the screenshots", description: reason(error) });
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Screenshot at sizes</DialogTitle>
          <DialogDescription>
            The page is laid out at each width in turn, then put back.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {choices.map((choice) => (
            <label key={choice.size} className="flex items-center gap-2 text-ui">
              <Checkbox
                checked={sizes.has(choice.size)}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setSizes((current) => {
                    const next = new Set(current);
                    if (checked) next.add(choice.size);
                    else next.delete(choice.size);
                    return next;
                  })
                }
              />
              {choice.label}
              <span className="text-xs text-subtle-foreground tabular-nums">{choice.width}px</span>
            </label>
          ))}
          <label className="mt-2 flex items-center gap-2 text-ui">
            <Checkbox checked={fullPage} disabled={busy} onCheckedChange={setFullPage} />
            Whole page
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || sizes.size === 0 || !capture}
            onClick={() => void take()}
          >
            {busy ? "Taking screenshots…" : "Take screenshots"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
