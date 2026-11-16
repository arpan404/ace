import { RegionScene, useRegionScene } from "@/features/suits/index.ts";

/**
 * A Suit's `page` scene (`scenes.page`) behind a full page's content, over its canvas colour.
 * The scene keeps its own stacking layer, so the canvas itself stays out of one and the page's
 * content stacks as it always has. Renders nothing while the Suit names no page scene.
 */
export function PageScene() {
  const { url } = useRegionScene("page");
  if (!url) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 isolate">
      <RegionScene region="page" />
    </div>
  );
}
