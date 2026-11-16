import { walk, type CssNode } from "css-tree";

/*
 * Which `@media` queries a Suit's CSS may use: the person's preferences (`prefers-*`) and the
 * window's width, so a Suit adapts to the device without sniffing anything else. Pure.
 */

const widths = new Set(["width", "min-width", "max-width"]);
const mediaTypes = new Set(["all", "screen"]);
const words = new Set(["and", "or", "not", "only"]);

const allowedFeature = (name: string) => {
  const lower = name.toLowerCase();
  return lower.startsWith("prefers-") || widths.has(lower);
};

/** Why `prelude` can't be used, or undefined when it can. */
export function checkMedia(prelude: CssNode | null): string | undefined {
  if (!prelude || prelude.type !== "AtrulePrelude") return "@media needs a query";
  let reason: string | undefined;
  const fail = (message: string) => {
    reason ??= message;
  };
  walk(prelude, {
    enter(node: CssNode) {
      switch (node.type) {
        case "MediaQuery":
          if (node.mediaType && !mediaTypes.has(node.mediaType.toLowerCase()))
            fail(`@media ${node.mediaType} is not allowed; use screen or all`);
          break;
        case "Feature":
          if (!allowedFeature(node.name))
            fail(`@media (${node.name}) is not allowed; use prefers-* or width`);
          // A feature's own value (`dark`, `600px`) is not a feature name.
          return walk.skip;
        case "FeatureRange": {
          const names = [node.left, node.middle, node.right].flatMap((side) =>
            side && side.type === "Identifier" ? [side.name] : [],
          );
          if (names.length !== 1 || !names.every(allowedFeature))
            fail("@media ranges may only compare width");
          return walk.skip;
        }
        case "Identifier":
          if (!words.has(node.name.toLowerCase()))
            fail(`@media ${node.name} is not allowed; use prefers-* or width`);
          break;
        case "Raw":
          fail("this @media query doesn't parse");
          break;
        default:
          break;
      }
      return undefined;
    },
  });
  return reason;
}
