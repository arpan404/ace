import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3 text-[12px] leading-relaxed" title={error}>
          {error}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss error"
              className="inline-flex size-6 items-center justify-center rounded-lg text-destructive/50 transition-all duration-200 hover:bg-destructive/10 hover:text-destructive"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
