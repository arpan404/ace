import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@ace/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const [dismissedStatusKey, setDismissedStatusKey] = useState<string | null>(null);

  const statusKey = useMemo(() => {
    if (!status || status.status === "ready" || status.status === "disabled") {
      return null;
    }
    return `${status.provider}:${status.status}:${status.message ?? ""}`;
  }, [status]);

  useEffect(() => {
    if (statusKey === null) {
      setDismissedStatusKey(null);
    }
  }, [statusKey]);

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  if (dismissedStatusKey === statusKey) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <Tooltip>
          <TooltipTrigger
            render={
              <AlertDescription className="line-clamp-3 text-[12px] leading-relaxed">
                {status.message ?? defaultMessage}
              </AlertDescription>
            }
          />
          <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
            {status.message ?? defaultMessage}
          </TooltipPopup>
        </Tooltip>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss provider status"
            className="inline-flex size-6 items-center justify-center rounded-lg text-destructive/50 transition-all duration-200 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              if (statusKey !== null) {
                setDismissedStatusKey(statusKey);
              }
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
