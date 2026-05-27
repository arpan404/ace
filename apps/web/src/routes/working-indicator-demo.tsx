import { createFileRoute } from "@tanstack/react-router";
import { cn } from "~/lib/utils";

function WorkingIndicatorDemoRouteView() {
  return (
    <div className="grid h-dvh min-h-0 place-items-center bg-background text-foreground">
      <div className="space-y-4 text-center">
        <div className="text-sm font-medium text-muted-foreground">Working indicator preview</div>
        <div className="flex items-center justify-center gap-3">
          <span
            aria-hidden="true"
            className={cn("working-activity-indicator")}
            data-working-activity-indicator="true"
            style={{ fontSize: "3rem" }}
          >
            <span className="working-activity-indicator-dot" />
            <span className="working-activity-indicator-dot" />
            <span className="working-activity-indicator-dot" />
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Open <code className="rounded bg-muted px-1 py-0.5">/working-indicator-demo</code>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/working-indicator-demo")({
  component: WorkingIndicatorDemoRouteView,
});

