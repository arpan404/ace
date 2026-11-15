import type { SuitManifest, SuitProblem } from "@ace/protocol/suits";
import type { SuitOrnamentSlot, SuitSceneRegion } from "@ace/protocol/suit-parts";
import { problem } from "./checks.ts";
import { sanitiseOrnament } from "./ornaments.ts";

/*
 * What a Suit puts in each region (ADR 0150, "Scenes per region" and "Ornaments"): the scene
 * file each region runs and the sanitised ornament markup each slot shows. Pure: the files come
 * in as bytes, the served URL of an asset as a function.
 */

/** A scene script at the folder's root: `scene.js` or another `<name>.js`. */
export const isSceneFile = (path: string) => /^[A-Za-z0-9-]+\.js$/.test(path);

/** The page that runs `file` (`city.js` → `city.html`). */
export const scenePageFor = (file: string) => file.replace(/\.js$/, ".html");

/**
 * The scene file per region: `scenes` from suit.json over `scene.js` as the app's. A region
 * naming a file the folder doesn't have is a problem and runs nothing.
 */
export function regionScenes(
  manifest: Pick<SuitManifest, "scenes">,
  files: ReadonlySet<string>,
): { scenes: Partial<Record<SuitSceneRegion, string>>; problems: SuitProblem[] } {
  const wanted: Partial<Record<SuitSceneRegion, string>> = {
    ...(files.has("scene.js") ? { app: "scene.js" } : {}),
    ...manifest.scenes,
  };
  const scenes: Partial<Record<SuitSceneRegion, string>> = {};
  const problems: SuitProblem[] = [];
  for (const [region, file] of Object.entries(wanted) as [SuitSceneRegion, string][]) {
    if (files.has(file)) scenes[region] = file;
    else
      problems.push(
        problem("scene", `scenes.${region} names ${file}, which is missing`, `scenes.${region}`),
      );
  }
  return { scenes, problems };
}

/** Each slot's sanitised markup, ornaments sharing a slot in suit.json's order, and their problems. */
export function regionOrnaments(
  manifest: Pick<SuitManifest, "ornaments">,
  files: ReadonlyMap<string, Uint8Array>,
  asset: (path: string) => string | undefined,
): { ornaments: Partial<Record<SuitOrnamentSlot, string>>; problems: SuitProblem[] } {
  const ornaments: Partial<Record<SuitOrnamentSlot, string>> = {};
  const problems: SuitProblem[] = [];
  for (const [index, ornament] of (manifest.ornaments ?? []).entries()) {
    const bytes = files.get(ornament.asset);
    if (!bytes) {
      problems.push(
        problem("ornament", `ornaments names ${ornament.asset}, which is missing`, ornament.asset),
      );
      continue;
    }
    const clean = sanitiseOrnament({ path: ornament.asset, index, bytes, asset });
    problems.push(...clean.problems);
    if (clean.markup) ornaments[ornament.slot] = (ornaments[ornament.slot] ?? "") + clean.markup;
  }
  return { ornaments, problems };
}
