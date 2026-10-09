import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"])
  test(`every provider mark fits its box and follows ${theme} ink`, async ({ page }) => {
    await page.addInitScript((chosen) => {
      localStorage.setItem("ace.appearance", JSON.stringify({ theme: chosen }));
      Object.assign(globalThis, { aceFakeWorld: "empty" });
    }, theme);
    await page.goto("/new");
    await page.getByRole("heading", { name: "New thread", exact: true }).waitFor();
    for (const size of [12, 16, 20] as const) {
      await page.evaluate(async (pixels) => {
        document.querySelector('section[aria-label="Provider marks"]')?.remove();
        const path = "/src/test/provider-mark-gallery.tsx";
        const module = await import(path);
        module.showProviderMarks(pixels);
      }, size);
      // Wait for all marks to have visible ink, including their lazy chunks.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              [
                ...document.querySelectorAll<SVGSVGElement>(
                  'section[aria-label="Provider marks"] svg',
                ),
              ].filter((svg) => svg.getBBox().width > 0).length,
          ),
        )
        .toBe(58);
      const results = await page.evaluate(async () => {
        const samples = [];
        for (const original of document.querySelectorAll<SVGSVGElement>(
          'section[aria-label="Provider marks"] svg',
        )) {
          const box = original.viewBox.baseVal;
          const pixelsWide = original.width.baseVal.value;
          const pad = 4;
          const svg = original.cloneNode(true) as SVGSVGElement;
          const ink = getComputedStyle(original).color;
          svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          svg.style.color = ink;
          svg.setAttribute("width", String(pixelsWide + pad * 2));
          svg.setAttribute("height", String(pixelsWide + pad * 2));
          // Extend the actual viewport, so ink outside the original box cannot be silently clipped.
          svg.setAttribute(
            "viewBox",
            `${box.x - (box.width * pad) / pixelsWide} ${box.y - (box.height * pad) / pixelsWide} ${(box.width * (pixelsWide + pad * 2)) / pixelsWide} ${(box.height * (pixelsWide + pad * 2)) / pixelsWide}`,
          );
          const image = new Image();
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = pixelsWide + pad * 2;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0,
            outside = 0,
            themed = 0,
            sampled = 0;
          const expected = ink.match(/\d+/g)?.map(Number) ?? [];
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              const at = (y * canvas.width + x) * 4;
              if ((pixels[at + 3] ?? 0) < 8) continue;
              count++;
              if (x < pad || y < pad || x >= pad + pixelsWide || y >= pad + pixelsWide) outside++;
              if ((pixels[at + 3] ?? 0) >= 64) {
                sampled++;
                if (
                  expected
                    .slice(0, 3)
                    .every((channel, index) => Math.abs(channel - (pixels[at + index] ?? 0)) < 4)
                )
                  themed++;
              }
            }
          const centre =
            pixels[
              ((pad + Math.floor(pixelsWide / 2)) * canvas.width +
                pad +
                Math.floor(pixelsWide / 2)) *
                4 +
                3
            ] ?? 0;
          samples.push({
            label: original.getAttribute("aria-label") ?? "",
            count,
            outside,
            themed,
            sampled,
            centre,
          });
        }
        return samples;
      });
      for (const result of results) {
        expect(result.count, `${result.label} ${size}px has ink`).toBeGreaterThan(3);
        expect(result.outside, `${result.label} ${size}px stays in the box`).toBe(0);
        if (result.label.endsWith(" mono"))
          expect(result.themed / result.sampled, `${result.label} follows theme`).toBeGreaterThan(
            0.95,
          );
        if (result.label.startsWith("opencode")) {
          expect(result.themed / result.sampled).toBeGreaterThan(0.95);
          expect(result.centre, "OpenCode has a transparent centre, not a favicon tile").toBe(0);
        }
      }
      if (size === 16) {
        await page.screenshot({
          path: `/tmp/ace-orch/shots/feat-machine-identity/providers-${theme}-1440.png`,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole("img", { name: "zai mono", exact: true })).toBeInViewport();
        await page.screenshot({
          path: `/tmp/ace-orch/shots/feat-machine-identity/providers-${theme}-390.png`,
        });
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    }
  });
