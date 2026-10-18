const ns = "http://www.w3.org/2000/svg";

/** 16 px stroke icons drawn for ace; geometry only, coloured by `currentColor`. */
const paths = {
  screenshot: [
    "M2.5 5.5v-2a1 1 0 0 1 1-1h2",
    "M10.5 2.5h2a1 1 0 0 1 1 1v2",
    "M13.5 10.5v2a1 1 0 0 1-1 1h-2",
    "M5.5 13.5h-2a1 1 0 0 1-1-1v-2",
    "M8 5.75a2.25 2.25 0 1 1 0 4.5a2.25 2.25 0 1 1 0-4.5z",
  ],
  eye: [
    "M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8s-2.25 4.25-6.25 4.25S1.75 8 1.75 8z",
    "M8 6a2 2 0 1 1 0 4a2 2 0 1 1 0-4z",
  ],
  eyeOff: [
    "M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8s-2.25 4.25-6.25 4.25S1.75 8 1.75 8z",
    "M8 6a2 2 0 1 1 0 4a2 2 0 1 1 0-4z",
    "M2.5 2.5l11 11",
  ],
  compare: [
    "M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z",
    "M8 2.5v11",
  ],
  trash: [
    "M2.75 4.25h10.5",
    "M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25",
    "M4 4.25l.6 8.4a1 1 0 0 0 1 .93h4.8a1 1 0 0 0 1-.93l.6-8.4",
  ],
  close: ["M4.25 4.25l7.5 7.5", "M11.75 4.25l-7.5 7.5"],
  send: ["M8 12.5v-9", "M4.25 7.25L8 3.5l3.75 3.75"],
  chevron: ["M5 6.5l3 3l3-3"],
  sliders: [
    "M2.5 5h5.5",
    "M12 5h1.5",
    "M2.5 11h1.5",
    "M8 11h5.5",
    "M10 3.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z",
    "M6 9.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z",
  ],
} as const;

export type IconName = keyof typeof paths | "grip";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  if (name === "grip") {
    for (const [cx, cy] of [
      [6, 4],
      [10, 4],
      [6, 8],
      [10, 8],
      [6, 12],
      [10, 12],
    ] as const) {
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", String(cx));
      dot.setAttribute("cy", String(cy));
      dot.setAttribute("r", "1.1");
      dot.setAttribute("fill", "currentColor");
      svg.append(dot);
    }
    return svg;
  }
  for (const d of paths[name]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}
