import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";

/** Both the lazy renderer and its worker use this placeholder, never the markdown source. */
export function MarkdownLoading(props: { text: string; className?: string | undefined }) {
  return props.text ? (
    <LoadingRegion label="message" className={props.className ?? ""}>
      <SkeletonText />
    </LoadingRegion>
  ) : null;
}
