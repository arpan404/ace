import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";

/** Reserve wrapped text lines while the lazy renderer or worker prepares a message. */
export function MarkdownLoading(props: { text: string; className?: string | undefined }) {
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
