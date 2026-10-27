import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { ForgeFile } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { formatBytes } from "@/components/format-bytes.ts";
import type { HostedFileShow } from "@ace/ui-core";
import type { FileSides, HostedSide } from "./pr-file-sides.ts";
import { PrImageDiff } from "./pr-image-diff.tsx";
import { PrRenderedDiff } from "./pr-rendered-diff.tsx";

/** How far below the viewport a file starts reading. */
const ahead = "600px 0px";

/** Asks once for what it stands in for as it nears the viewport (at once without an observer). */
function NearView(props: {
  root: RefObject<HTMLElement | null>;
  onNear(): void;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const { root, onNear } = props;
  useEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      onNear();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onNear();
      },
      { root: root.current, rootMargin: ahead },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [root, onNear]);
  return <div ref={element}>{props.children}</div>;
}

function Reading(props: { path: string }) {
  return (
    <div role="status" aria-label={`Reading ${props.path}`} className="px-3.5 py-2.5">
      <SkeletonText lines={3} className="max-w-120" />
    </div>
  );
}

const line = "flex min-h-8 items-center gap-3 px-3.5 py-1.5 text-xs text-muted-foreground";

const sizes = (base: HostedSide, head: HostedSide) =>
  [base, head]
    .flatMap((side) =>
      side.kind === "missing" ? [] : [formatBytes("size" in side ? side.size : 0)],
    )
    .join(" → ");

/**
 * What a file shows in place of diff lines, or undefined when its lines show: a read in progress
 * or failed, an image, a binary or oversized file, a rendered document, or a diff too large to
 * read until asked. `sides` is undefined until the file is wanted.
 */
export function prFileBody(props: {
  file: ForgeFile;
  show: HostedFileShow;
  rendered: "markdown" | "notebook" | undefined;
  sides: FileSides | undefined;
  root: RefObject<HTMLElement | null>;
  onWant(): void;
  onRetry(): void;
}): ReactNode {
  const { file, sides } = props;
  if (props.show === "patch" && !props.rendered) return undefined;
  if (!sides) {
    if (props.show === "large" && !props.rendered)
      return (
        <div className={line}>
          <span className="tabular-nums">
            {(file.additions + file.deletions).toLocaleString()} lines changed
          </span>
          <Button size="xs" onClick={props.onWant}>
            Load diff
          </Button>
        </div>
      );
    return (
      <NearView root={props.root} onNear={props.onWant}>
        <Reading path={file.path} />
      </NearView>
    );
  }
  if (sides.state === "pending") return <Reading path={file.path} />;
  if (sides.state === "failed")
    return (
      <div role="alert" className={line}>
        <span>Couldn't read this file. {sides.error.message}</span>
        <Button size="xs" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  const { base, head } = sides;
  const kinds = [base.kind, head.kind];
  if (kinds.includes("large"))
    return <p className={line}>Too large to show here · {sizes(base, head)}</p>;
  if (props.show === "image" && kinds.every((kind) => kind === "image" || kind === "missing"))
    return (
      <PrImageDiff
        path={file.path}
        {...(base.kind === "image" ? { base } : {})}
        {...(head.kind === "image" ? { head } : {})}
      />
    );
  if (kinds.some((kind) => kind === "binary" || kind === "image"))
    return <p className={line}>Binary file · {sizes(base, head)}</p>;
  if (props.rendered)
    return (
      <PrRenderedDiff
        kind={props.rendered}
        path={file.path}
        before={base.kind === "text" ? base.text : null}
        after={head.kind === "text" ? head.text : null}
      />
    );
  return undefined;
}
