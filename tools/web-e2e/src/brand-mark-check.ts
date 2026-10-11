import { expect, type Locator } from "@playwright/test";
import { brandArt, type Brand, type BrandPath } from "@ace/ui-core/provider-icons";

const attributes = (values: Record<string, string | number | undefined>) =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(" ");

function pathMarkup(path: BrandPath, index: number): string {
  return `<path ${attributes({ d: path.d, fill: path.gradient ? `url(#g${index})` : (path.fill ?? "currentColor"), "fill-rule": path.fillRule, "clip-rule": path.clipRule, opacity: path.opacity })}/>`;
}

/** Compare visible ink to the approved registry asset, so a blank or generic mark fails. */
export async function expectBrandMark(mark: Locator, brand: Brand, size: number): Promise<void> {
  const art = await brandArt[brand]();
  const paths = art.color ?? art.mono;
  const defs = paths
    .map((path, index) => {
      const gradient = path.gradient;
      if (!gradient) return "";
      const tag = gradient.type === "radial" ? "radialGradient" : "linearGradient";
      return `<${tag} id="g${index}" ${attributes(gradient.attributes)}>${gradient.stops.map((stop) => `<stop ${attributes({ offset: stop.offset, "stop-color": stop.color, "stop-opacity": stop.opacity })}/>`).join("")}</${tag}>`;
    })
    .join("");
  const reference = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${art.viewBox}"><defs>${defs}</defs>${paths.map(pathMarkup).join("")}</svg>`;
  await expect
    .poll(
      async () =>
        mark.evaluate(
          async (element, input) => {
            if (!(element instanceof SVGSVGElement))
              throw new Error("Expected a visible provider mark");
            const actual = element.cloneNode(true);
            if (!(actual instanceof SVGSVGElement))
              throw new Error("Unable to capture provider mark");
            actual.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            actual.style.color = getComputedStyle(element).color;
            const expected = new DOMParser().parseFromString(
              input.reference,
              "image/svg+xml",
            ).documentElement;
            expected.setAttribute("style", `color:${getComputedStyle(element).color}`);
            const raster = async (svg: Element) => {
              const image = new Image();
              image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = input.size * 3;
              const context = canvas.getContext("2d");
              if (!context) throw new Error("Canvas unavailable");
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              return context.getImageData(0, 0, canvas.width, canvas.height).data;
            };
            const [painted, approved] = await Promise.all([raster(actual), raster(expected)]);
            let difference = 0,
              ink = 0;
            for (let index = 0; index < approved.length; index++) {
              difference += Math.abs((painted[index] ?? 0) - (approved[index] ?? 0));
              if (index % 4 === 3 && (painted[index] ?? 0) > 8) ink++;
            }
            return ink > 3 && difference < 8;
          },
          { reference, size },
        ),
      { message: `${brand} renders its approved colour brand mark at ${size}px` },
    )
    .toBe(true);
}
