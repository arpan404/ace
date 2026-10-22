import { useLayoutEffect, useRef, useState } from "react";
import type { ForgeComment } from "@ace/protocol";
import { ForgeProse } from "./rich/forge-prose.tsx";
import { useCommentTasks } from "./rich/comment-tasks.ts";

/**
 * A comment body clamped to about six whole lines, with Show more when it runs longer. Whether
 * it is open is the caller's, so a list that remounts its rows (virtualized) keeps it. With
 * `comment`, its task boxes tick when the viewer may edit it.
 */
export function PrClampedText(props: {
  text: string;
  open: boolean;
  onToggle(): void;
  comment?: ForgeComment | undefined;
}) {
  if (props.comment) return <CommentText {...props} comment={props.comment} />;
  return <ClampedText {...props} tasks={undefined} />;
}

function CommentText(props: {
  text: string;
  open: boolean;
  onToggle(): void;
  comment: ForgeComment;
}) {
  return <ClampedText {...props} tasks={useCommentTasks(props.comment)} />;
}

function ClampedText(props: {
  text: string;
  open: boolean;
  onToggle(): void;
  tasks: ((next: string) => Promise<boolean>) | undefined;
}) {
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
        <ForgeProse text={props.text} tasks={props.tasks} className="text-ui leading-normal" />
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
