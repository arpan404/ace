import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flakyCheckout } from "@ace/fake-daemon";
import { configure, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

/*
 * The composer and its strip as the browser cascades the floating material on them
 * (styles/glass.css). jsdom doesn't apply rules inside `@layer`, so the layer wrapper is lifted.
 */
const glassCss = readFileSync(join(import.meta.dirname, "../../../styles/glass.css"), "utf8");
let style: HTMLStyleElement;
beforeEach(() => {
  localStorage.clear();
  style = document.createElement("style");
  style.textContent = glassCss.replace(
    /@layer components \{([\s\S]*)\}\s*(@keyframes[\s\S]*)$/,
    "$1\n$2",
  );
  document.head.append(style);
});
afterEach(() => {
  style.remove();
  for (const name of ["data-surface", "data-theme", "data-scheme", "style"])
    document.documentElement.removeAttribute(name);
});

const frosted = (element: Element) =>
  /blur\(/.test(getComputedStyle(element).getPropertyValue("backdrop-filter"));

/** A thread waiting on an approval: its card sits in the strip attached above the composer. */
async function threadWithStrip(translucency?: number) {
  const storage = memoryKeyValue();
  if (translucency !== undefined)
    storage.setItem("ace.appearance", JSON.stringify({ translucency }));
  const app = harness({ storage });
  app.play(flakyCheckout()).runThrough("approval-requested");
  await app.open("/t/thread-checkout");
  await screen.findByRole("region", { name: "Waiting for you" });
  const area = document.querySelector("[data-composer-area]");
  const composer = document.querySelector('[data-slot="composer"]');
  const strip = document.querySelector("[data-composer-strip] .ace-glass-dock");
  if (!area || !composer || !strip) throw new Error("no composer and strip");
  return { area, composer, strip };
}

test("the composer and its strip are glass while Translucency is above Solid", async () => {
  const { composer, strip } = await threadWithStrip();
  expect(document.documentElement.getAttribute("data-surface")).toBe("translucent");
  expect(frosted(composer)).toBe(true);
  expect(frosted(strip)).toBe(true);
  // One tint for both, driven by the slider.
  expect(getComputedStyle(composer).getPropertyValue("background")).toBe("var(--glass-tint)");
  expect(getComputedStyle(strip).getPropertyValue("background")).toBe("var(--glass-tint)");
});

test("at Solid the composer and its strip are solid, with no backdrop filter", async () => {
  const { composer, strip } = await threadWithStrip(0);
  expect(document.documentElement.getAttribute("data-surface")).toBe("solid");
  expect([frosted(composer), frosted(strip)]).toEqual([false, false]);
  expect(getComputedStyle(composer).getPropertyValue("background")).toBe("var(--surface-2)");
});

test("the composer area never frosts glass on glass: no blur inside a blur, and the strip's glass stops at the composer's edge", async () => {
  const { area, strip } = await threadWithStrip();
  const nested = [...area.querySelectorAll("*")].filter((element) => {
    if (!frosted(element)) return false;
    for (let up = element.parentElement; up; up = up.parentElement) if (frosted(up)) return true;
    return false;
  });
  expect(nested).toEqual([]);
  // The strip tucks under the composer; its glass is clipped where the composer begins, so the
  // composer frosts the transcript and never the strip's already frosted glass.
  expect(getComputedStyle(strip).getPropertyValue("clip-path")).toMatch(/^inset\(/);
});

test("a menu opened from the glass composer is solid", async () => {
  await threadWithStrip();
  await userEvent.click(screen.getByRole("button", { name: /^Approvals:/ }));
  const menu = await screen.findByRole("menu");
  expect(menu.classList.contains("ace-floating-solid")).toBe(true);
  expect(frosted(menu)).toBe(false);
});
