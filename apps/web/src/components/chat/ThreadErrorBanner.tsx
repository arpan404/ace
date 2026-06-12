import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
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

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  onOpenDiagnostics,
  onRetryLastMessage,
}: ThreadErrorBannerProps) {
  if (!error) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error" className={cn(GLASS_BANNER_CLASS_NAME, GLASS_BANNER_ERROR_CLASS_NAME)}>
        <CircleAlertIcon />
        <Tooltip>
          <TooltipTrigger
            render={
              <AlertDescription className="line-clamp-3 text-[12px] leading-relaxed">
                {error}
              </AlertDescription>
            }
          />
          <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
            {error}
          </TooltipPopup>
        </Tooltip>
        {(onOpenDiagnostics || onRetryLastMessage || onDismiss) && (
          <AlertAction>
            <div className="flex items-center gap-1">
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
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
