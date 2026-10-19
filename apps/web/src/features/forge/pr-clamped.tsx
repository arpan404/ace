import { useLayoutEffect, useRef, useState } from "react";
import { Prose } from "@/components/markdown/prose.tsx";

/**
 * A comment body clamped to about six whole lines, with Show more when it runs longer. Whether
 * it is open is the caller's, so a list that remounts its rows (virtualized) keeps it.
 */
export function PrClampedText(props: { text: string; open: boolean; onToggle(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const open = props.open;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || open) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  if (!props.text.trim()) return null;
  return (
    <div>
      <div ref={box} className={open ? undefined : "line-clamp-6"}>
        <Prose text={props.text} className="text-ui leading-normal" />
      </div>
      {(overflows || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={props.onToggle}
          className="mt-1 text-xs text-link hover:underline focus-ring"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
