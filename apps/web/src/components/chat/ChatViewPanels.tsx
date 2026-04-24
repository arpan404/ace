import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ComponentProps } from "react";

import { InAppBrowser, type InAppBrowserMode } from "../InAppBrowser";
import PlanSidebar from "../PlanSidebar";
import { Button } from "../ui/button";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

const BROWSER_PANEL_TRANSITION = {
  duration: 0.22,
  ease: [0.16, 1, 0.3, 1],
} as const;

interface BrowserPanelProps {
  mode: InAppBrowserMode;
  splitWidth: number;
  onResizeKeyDown: ComponentProps<"div">["onKeyDown"];
  onResizePointerDown: ComponentProps<"div">["onPointerDown"];
  instances: ReadonlyArray<{
    key: string;
    inAppBrowserProps: ComponentProps<typeof InAppBrowser>;
  }>;
}

interface ExpandedImageOverlayProps {
  closeExpandedImage: () => void;
  expandedImage: ExpandedImagePreview;
  expandedImageItem: ExpandedImagePreview["images"][number];
  navigateExpandedImage: (direction: -1 | 1) => void;
}

function ExpandedImageOverlay({
  closeExpandedImage,
  expandedImage,
  expandedImageItem,
  navigateExpandedImage,
}: ExpandedImageOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={closeExpandedImage}
      />
      {expandedImage.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => {
            navigateExpandedImage(-1);
          }}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={closeExpandedImage}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        <img
          src={expandedImageItem.src}
          alt={expandedImageItem.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border bg-background object-contain"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground">
          {expandedImageItem.name}
          {expandedImage.images.length > 1
            ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
            : ""}
        </p>
      </div>
      {expandedImage.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => {
            navigateExpandedImage(1);
          }}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>
  );
}

export function ChatViewPanels({
  browserPanel,
  expandedImageOverlay,
  planSidebarProps,
}: {
  browserPanel: BrowserPanelProps | null;
  expandedImageOverlay: ExpandedImageOverlayProps | null;
  planSidebarProps: ComponentProps<typeof PlanSidebar> | null;
}) {
  return (
    <>
      {planSidebarProps ? <PlanSidebar {...planSidebarProps} /> : null}
      <AnimatePresence initial={false}>
        {browserPanel ? (
          browserPanel.mode === "split" ? (
            <motion.div
              key="browser-split-panel"
              className="flex h-full min-h-0 shrink-0 overflow-hidden"
              initial={{ width: 0, opacity: 0, x: 18 }}
              animate={{ width: "auto", opacity: 1, x: 0 }}
              exit={{ width: 0, opacity: 0, x: 18 }}
              transition={BROWSER_PANEL_TRANSITION}
            >
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize browser panel"
                aria-valuenow={browserPanel.splitWidth}
                tabIndex={0}
                className="group relative z-20 w-3 shrink-0 cursor-col-resize touch-none select-none"
                onKeyDown={browserPanel.onResizeKeyDown}
                onPointerDown={browserPanel.onResizePointerDown}
              >
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/55" />
                <div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2 rounded-full bg-transparent group-hover:bg-primary/10" />
              </div>
              <div
                className="relative z-0 min-h-0 shrink-0 overflow-hidden"
                style={{
                  width: `${browserPanel.splitWidth}px`,
                  minWidth: `${browserPanel.splitWidth}px`,
                }}
              >
                {browserPanel.instances.map((instance) => (
                  <InAppBrowser key={instance.key} {...instance.inAppBrowserProps} />
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="browser-full-panel"
              className="absolute inset-0 z-30 min-h-0 min-w-0"
              initial={{ opacity: 0, scale: 0.99 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.99 }}
              transition={BROWSER_PANEL_TRANSITION}
            >
              {browserPanel.instances.map((instance) => (
                <InAppBrowser key={instance.key} {...instance.inAppBrowserProps} />
              ))}
            </motion.div>
          )
        ) : null}
      </AnimatePresence>
      {expandedImageOverlay ? <ExpandedImageOverlay {...expandedImageOverlay} /> : null}
    </>
  );
}
