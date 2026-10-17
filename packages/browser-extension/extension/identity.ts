import type { UserBrowserFamily } from "@ace/protocol";

export interface Brand {
  brand: string;
  version: string;
}

const families: [string, UserBrowserFamily][] = [
  ["Microsoft Edge", "edge"],
  ["Brave", "brave"],
  ["Opera", "opera"],
  ["Vivaldi", "vivaldi"],
  ["Google Chrome", "chrome"],
  ["Chromium", "chromium"],
];

/** Which browser this is, from its user-agent brands; a browser with no brand of its own is Chromium. */
export function browserFamily(brands: readonly Brand[]): {
  family: UserBrowserFamily;
  version: string;
} {
  for (const [name, family] of families) {
    const brand = brands.find((entry) => entry.brand === name);
    if (brand) return { family, version: brand.version.slice(0, 64) };
  }
  return { family: "other", version: "" };
}
