import "katex/dist/katex.min.css";
import { renderToString } from "katex";
import { setMathRenderer } from "./math-cache.ts";

/*
 * KaTeX on the main thread, loaded lazily: `Formula` and the idle warm-up
 * dynamically import this module, so KaTeX (code, CSS and fonts, all bundled
 * locally) lands in its own lazy chunk and never in the main bundle.
 * Evaluating the module registers the renderer, after which formulas render
 * synchronously in their first commit. Only KaTeX's own HTML is ever
 * injected, and only with the safety settings in `@ace/ui-core/math-render`.
 */

setMathRenderer(renderToString);
