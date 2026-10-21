import { useState } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Slider } from "@/components/ui/slider.tsx";
import { formatBytes } from "@/components/format-bytes.ts";
import { cn } from "@/lib/cn.ts";

type Image = { url: string; size: number };
type Layout = "side" | "swipe";

const frame = "max-h-[60vh] max-w-full rounded-sm object-contain shadow-[0_0_0_1px_var(--border)]";

function Figure(props: { image: Image; label: string; alt: string }) {
  return (
    <figure className="flex min-w-0 flex-col items-center gap-2">
      <img src={props.image.url} alt={props.alt} className={frame} />
      <figcaption className="text-xs text-subtle-foreground tabular-nums">
        {props.label} · {formatBytes(props.image.size)}
      </figcaption>
    </figure>
  );
}

/**
 * A changed image: the one side there is, or both, side by side or stacked with a swipe that
 * reveals the new version over the old (the slider is keyboard reachable: arrows move it).
 */
export function PrImageDiff(props: { path: string; base?: Image; head?: Image }) {
  const [layout, setLayout] = useState<Layout>("side");
  const [reveal, setReveal] = useState(50);
  const { base, head } = props;
  if (!base || !head) {
    const only = head ?? base;
    return only ? (
      <div className="flex justify-center p-4">
        <Figure image={only} label={head ? "Added" : "Removed"} alt={props.path} />
      </div>
    ) : null;
  }
  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <SegmentedControl
        label="Image comparison"
        size="sm"
        value={layout}
        onValueChange={(value: Layout) => setLayout(value)}
        options={[
          { value: "side", label: "Side by side" },
          { value: "swipe", label: "Swipe" },
        ]}
      />
      {layout === "side" ? (
        <div className="grid w-full grid-cols-2 items-start gap-4">
          <Figure image={base} label="Before" alt={`${props.path} before`} />
          <Figure image={head} label="After" alt={`${props.path} after`} />
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-2">
          <div className="relative grid place-items-center">
            <img
              src={base.url}
              alt={`${props.path} before`}
              className={cn(frame, "[grid-area:1/1]")}
            />
            <img
              src={head.url}
              alt={`${props.path} after`}
              className={cn(frame, "[grid-area:1/1]")}
              style={{ clipPath: `inset(0 0 0 ${reveal}%)` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-ring"
              style={{ left: `${reveal}%` }}
            />
          </div>
          <Slider
            label="Swipe between before and after"
            min={0}
            max={100}
            value={reveal}
            onValueChange={(value) => setReveal(typeof value === "number" ? value : 50)}
            valueText={(value) => `${value}% before`}
            className="w-full max-w-80"
          />
          <p className="text-xs text-subtle-foreground tabular-nums">
            {formatBytes(base.size)} → {formatBytes(head.size)}
          </p>
        </div>
      )}
    </div>
  );
}
