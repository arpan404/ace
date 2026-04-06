import { memo } from "react";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold tracking-[0.18em] text-emerald-500 uppercase">
          <span className="relative flex size-1.5">
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          Plan ready
        </span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/85">
            {planTitle}
          </span>
        ) : null}
      </div>
    </div>
  );
});
