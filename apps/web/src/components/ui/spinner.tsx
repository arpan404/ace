import { cn } from "@/lib/cn.ts";

/** 11px ring, 1s linear, in the working blue unless the caller tints it. */
function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      data-slot="spinner"
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      className={cn("spin-ring text-status-working", className)}
    />
  );
}

export { Spinner };
