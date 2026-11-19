import { renderToString } from "katex";
import { renderTex } from "@ace/ui-core/math-render";
import { expect, test } from "vitest";

/* Agent TeX is typeset within limits, on the web and the phone alike (`@ace/ui-core`). */

test("a box an agent's TeX asks for is held to 20 em, never as large as it asks", () => {
  const html = renderTex(renderToString, "\\rule{1000em}{1em}", false);
  expect(html).toContain("border-right-width:20em");
  expect(html).not.toContain("border-right-width:1000em");
});

test("a macro that expands forever is shown as source instead of hanging the renderer", () => {
  expect(renderTex(renderToString, "\\def\\loop{\\loop x}\\loop", false)).toBeUndefined();
});
