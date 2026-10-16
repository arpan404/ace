import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";
import type { ReactNode } from "react";

/** Show live text immediately; reserve wrapped lines while preparing settled messages. */
export function MarkdownLoading(props: {
  text: string;
  className?: string | undefined;
  streaming?: boolean | undefined;
  tail?: ReactNode;
}) {
  // Text already received must remain readable while either lazy code or the worker starts.
  // Plain text needs no parsing, and React escapes it just as it does a rendered token.
  if (props.streaming)
    return (
      <div className={props.className} style={{ whiteSpace: "pre-wrap" }}>
        {props.text}
        {props.tail}
      </div>
    );
  const lines = props.text
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 80)), 0);
  return props.text ? (
    <LoadingRegion label="message" className={props.className ?? ""}>
      <span className="block" style={{ minHeight: `${lines * 1.5}em` }}>
        <SkeletonText lines={Math.min(lines, 40)} />
      </span>
    </LoadingRegion>
  ) : null;
}
