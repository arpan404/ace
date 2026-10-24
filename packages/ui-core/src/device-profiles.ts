import { iphoneCutout } from "./device-catalog.ts";

/*
 * What an Apple device's front looks like, by model: its screen in points, how round the
 * screen's corners are, and how much black glass and metal surrounds it. Measured from Apple's
 * published dimensions (body width against the display's pixels over its pixel density) and the
 * display corner radius each model reports. A model ace doesn't know gets the current
 * generation's face. Pure.
 */

export interface AppleFace {
  /** The upright screen in points, until the device's first picture says otherwise. */
  screen: { width: number; height: number };
  /** The screen's corner radius in points; 0 for a square-cornered screen. */
  cornerRadius: number;
  /** Glass and metal beside the upright screen, as a fraction of its width. */
  side: number;
  /** Glass and metal above and below the upright screen, as a fraction of its width. */
  chin: number;
  /** The body's corner radius, as a fraction of the screen's width; concentric when omitted. */
  bodyRadius?: number;
  /** A round home button in the chin. */
  homeButton: boolean;
}

const face = (
  width: number,
  height: number,
  cornerRadius: number,
  side: number,
): AppleFace => ({ screen: { width, height }, cornerRadius, side, chin: side, homeButton: false });

/** Today's iPhone (17 Pro): what a model name ace can't read is drawn as. */
const modernIphone = face(402, 874, 62, 0.036);
/** The home-button iPhone (SE, 8 and earlier): square screen, deep forehead and chin. */
const homeIphone: AppleFace = {
  screen: { width: 375, height: 667 },
  cornerRadius: 0,
  side: 0.076,
  chin: 0.29,
  bodyRadius: 0.17,
  homeButton: true,
};

/** An iPhone's face from its Simulator name ("iPhone 16 Pro Max", "iPhone SE (3rd generation)"). */
export function iphoneFace(name: string): AppleFace {
  if (iphoneCutout(name) === "none") return homeIphone;
  if (/iPhone Air\b/i.test(name)) return face(420, 912, 62, 0.037);
  const big = /\b(Pro Max|Plus|Max)\b/i.test(name);
  const pro = /\bPro\b/i.test(name);
  const generation = /iPhone (\d+)/i.exec(name)?.[1];
  if (!generation) {
    if (/iPhone XR\b/i.test(name)) return face(414, 896, 41.5, 0.085);
    if (/iPhone X/i.test(name)) return big ? face(414, 896, 39, 0.065) : face(375, 812, 39, 0.068);
    return modernIphone;
  }
  const number = Number(generation);
  if (/\d+e\b/i.test(name)) return face(390, 844, 47.33, 0.053);
  if (number >= 17 || (number === 16 && pro))
    return big ? face(440, 956, 62, 0.034) : face(402, 874, 62, 0.036);
  if (number >= 15 || (number === 14 && pro))
    return big ? face(430, 932, 55, 0.042) : face(393, 852, 55, pro ? 0.04 : 0.05);
  if (number >= 12) {
    if (/\bmini\b/i.test(name)) return face(375, 812, 44, 0.06);
    return big ? face(428, 926, 53.33, 0.05) : face(390, 844, 47.33, 0.053);
  }
  if (number === 11)
    return pro
      ? big
        ? face(414, 896, 39, 0.065)
        : face(375, 812, 39, 0.068)
      : face(414, 896, 41.5, 0.087);
  return modernIphone;
}

/** Today's iPad Air: what an iPad ace can't read is drawn as. */
const modernIpad = face(820, 1180, 18, 0.066);

/** Whether an iPad still has a home button: the 9th generation iPad and the models before it. */
function ipadHasHomeButton(name: string): boolean {
  const generation = (family: string) =>
    Number(new RegExp(`${family} \\((\\d+)(st|nd|rd|th) generation\\)`, "i").exec(name)?.[1]);
  if (/iPad Pro \((9\.7|10\.5)-inch\)/i.test(name)) return true;
  if (/iPad Pro \(12\.9-inch\) \((1st|2nd) generation\)/i.test(name)) return true;
  if (/iPad mini/i.test(name)) return generation("iPad mini") <= 5;
  if (/iPad Air/i.test(name)) return generation("iPad Air") <= 3;
  return generation("iPad") <= 9;
}

/** An iPad's face from its Simulator name ("iPad Pro 13-inch (M4)", "iPad mini (A17 Pro)"). */
export function ipadFace(name: string): AppleFace {
  if (ipadHasHomeButton(name))
    return /iPad mini/i.test(name)
      ? { ...face(768, 1024, 0, 0.08), chin: 0.15, bodyRadius: 0.1, homeButton: true }
      : { ...face(810, 1080, 0, 0.07), chin: 0.12, bodyRadius: 0.08, homeButton: true };
  if (/iPad mini/i.test(name)) return face(744, 1133, 21.5, 0.08);
  const large = /\b(12\.9|13)-inch\b/i.test(name);
  if (/iPad Pro/i.test(name)) {
    // The M4 and later iPad Pro have the thinnest borders.
    const thin = /\(M[4-9]\)/i.test(name);
    if (large) return thin ? face(1032, 1376, 18, 0.042) : face(1024, 1366, 18, 0.05);
    return thin ? face(834, 1210, 18, 0.05) : face(834, 1194, 18, 0.055);
  }
  if (/iPad Air/i.test(name) && large) return face(1024, 1366, 18, 0.055);
  return modernIpad;
}
