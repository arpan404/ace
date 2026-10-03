import { cn } from "@/lib/cn.ts";

/** 11px ring, 1s linear. Grey by default; status colour only where status words are allowed. */
function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      data-slot="spinner"
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      className={cn("spin-ring text-muted-foreground", className)}
    />
  );
}

export { Spinner };
