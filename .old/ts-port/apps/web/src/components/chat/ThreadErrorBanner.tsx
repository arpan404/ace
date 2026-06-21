import { memo } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, RotateCcwIcon, WrenchIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { GLASS_BANNER_CLASS_NAME, GLASS_BANNER_ERROR_CLASS_NAME } from "../ui/glass";
import { cn } from "~/lib/utils";

interface ThreadErrorBannerProps {
  error: string | null;
  onDismiss?: () => void;
  onOpenDiagnostics?: () => void;
  onRetryLastMessage?: () => void;
}

export function ThreadErrorBanner({
  error,
  onDismiss,
  onOpenDiagnostics,
  onRetryLastMessage,
}: ThreadErrorBannerProps) {
  if (!error) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-20 z-50 px-4">
      <div className="pointer-events-auto mx-auto max-w-xl">
        <Alert
          variant="error"
          className={cn(
            GLASS_BANNER_CLASS_NAME,
            GLASS_BANNER_ERROR_CLASS_NAME,
            "grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5",
          )}
        >
          <CircleAlertIcon className="col-start-1 row-start-1 size-4" />
          <Tooltip>
            <TooltipTrigger
              render={
                <AlertDescription className="col-start-2 row-start-1 min-w-0 text-left text-[12px] leading-relaxed">
                  {error}
                </AlertDescription>
              }
            />
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
          {(onOpenDiagnostics || onRetryLastMessage || onDismiss) && (
            <div
              className="col-start-3 row-start-1 flex shrink-0 items-center justify-end gap-1 self-start"
              data-thread-error-banner-actions=""
            >
              {onRetryLastMessage ? (
                <Button type="button" size="xs" variant="outline" onClick={onRetryLastMessage}>
                  <RotateCcwIcon className="size-3" />
                  Retry
                </Button>
              ) : null}
              {onOpenDiagnostics ? (
                <Button type="button" size="xs" variant="outline" onClick={onOpenDiagnostics}>
                  <WrenchIcon className="size-3" />
                  Details
                </Button>
              ) : null}
              {onDismiss ? (
                <button
                  type="button"
                  aria-label="Dismiss error"
                  className="inline-flex size-6 items-center justify-center rounded-lg text-destructive/50 transition-all duration-200 hover:bg-destructive/10 hover:text-destructive"
                  onClick={onDismiss}
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : null}
            </div>
          )}
        </Alert>
      </div>
    </div>
  );
}
