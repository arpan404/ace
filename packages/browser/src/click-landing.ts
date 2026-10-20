import { z } from "zod";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { CallResult } from "./cdp.ts";

/*
 * Clicks land where they aim (ADR 0067), checked after the fact: before an agent's press is
 * dispatched, a probe in the target's document records what the press reaches first (pointer,
 * mouse, touch or click event). A press that reached nothing, or something else, is reported as
 * `not_hittable` or `covered` instead of `ok`: the coordinates Chromium used were not the page's.
 */

/**
 * Page-side, after `doc`, `receives(node)` and `expected` (what sits at the point, or null)
 * are defined: listens for the first press and returns the probe. A press on an embedded
 * document (an iframe at the point) is out of this document's sight, and a disabled control
 * takes no press at all, as for a person: both count as landed.
 */
const recorder = `
  const view = doc.defaultView;
  const kinds = ['pointerdown', 'mousedown', 'touchstart', 'click'];
  const probe = { landed: undefined };
  const record = (event) => {
    if (probe.landed !== undefined) return;
    const path = event.composedPath();
    const hit = path.length ? path[0] : event.target;
    probe.landed = !!hit && receives(hit);
  };
  for (const kind of kinds) view.addEventListener(kind, record, true);
  const embedded = !!expected && ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(expected.tagName);
  probe.finish = () => {
    for (const kind of kinds) view.removeEventListener(kind, record, true);
    if (probe.landed === undefined) return embedded || unpressable() ? 'landed' : 'missed';
    return probe.landed ? 'landed' : 'elsewhere';
  };
  return probe;`;

const helpers = `
  const within = (node, owner) => {
    for (let n = node; n; n = n.parentNode || n.host) if (n === owner) return true;
    return false;
  };
  const hitAt = (px, py) => {
    let hit = doc.elementFromPoint(px, py);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };`;

/** Runs on the target element (`this`) with the point it is pressed at, in its document. */
const elementProbe = `function(px, py) {
  const doc = this.ownerDocument;
  const target = this;
  ${helpers}
  const labels = this.labels ? [...this.labels] : [];
  const passes = doc.defaultView.getComputedStyle(this).pointerEvents === 'none';
  const receives = (hit) =>
    within(hit, target) || labels.some((label) => within(hit, label)) ||
    (passes && within(target, hit));
  const unpressable = () => target.matches(':disabled');
  const expected = hitAt(px, py);
  ${recorder}
}`;

/** Runs in the top document with a viewport point: the press must reach what sits there. */
const pointProbe = (x: number, y: number) => `(() => {
  const doc = document;
  const px = ${JSON.stringify(x)}, py = ${JSON.stringify(y)};
  ${helpers}
  const expected = hitAt(px, py);
  const receives = (hit) => !!expected && (within(hit, expected) || within(expected, hit));
  const unpressable = () => !!expected && expected.matches(':disabled');
  ${recorder}
})()`;

const Armed = z.object({ result: z.object({ objectId: z.string() }) });
const Outcome = z.enum(["landed", "missed", "elsewhere"]);

/** A probe waiting in the page for the press; undefined when the page couldn't take one. */
export interface LandingProbe {
  cdp: BrowserCdp;
  objectId: string;
}

function armed(cdp: BrowserCdp, raw: unknown): LandingProbe | undefined {
  const parsed = Armed.safeParse(raw);
  return parsed.success ? { cdp, objectId: parsed.data.result.objectId } : undefined;
}

/** Arms a probe on an element (by its remote object) pressed at `point`, in its document. */
export async function armElementLanding(
  cdp: BrowserCdp,
  objectId: string,
  point: { x: number; y: number },
): Promise<LandingProbe | undefined> {
  return armed(
    cdp,
    await cdp
      .send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: elementProbe,
        arguments: [{ value: point.x }, { value: point.y }],
        returnByValue: false,
      })
      .catch(() => undefined),
  );
}

/** Arms a probe for a press at a viewport point of the top document. */
export async function armPointLanding(
  cdp: BrowserCdp,
  point: { x: number; y: number },
): Promise<LandingProbe | undefined> {
  return armed(
    cdp,
    await cdp
      .send("Runtime.evaluate", { expression: pointProbe(point.x, point.y), returnByValue: false })
      .catch(() => undefined),
  );
}

/**
 * Where the press went. A page that went away meanwhile (the press navigated it) or a probe
 * that can't be read counts as landed: the press evidently did something.
 */
export async function landing(probe: LandingProbe): Promise<z.infer<typeof Outcome>> {
  try {
    const result = CallResult.parse(
      await probe.cdp.send("Runtime.callFunctionOn", {
        objectId: probe.objectId,
        functionDeclaration: "function() { return this.finish(); }",
        returnByValue: true,
      }),
    );
    if (result.exceptionDetails) return "landed";
    const outcome = Outcome.safeParse(result.result.value);
    return outcome.success ? outcome.data : "landed";
  } catch {
    return "landed";
  } finally {
    await probe.cdp
      .send("Runtime.releaseObject", { objectId: probe.objectId })
      .catch(() => undefined);
  }
}

/**
 * Runs `press` with `probe` armed, and fails when it didn't land: `covered` when a press aimed
 * at an element (`aimedAtElement`) reached another one, `not_hittable` when it reached nothing
 * or, aimed at a bare point, reached something else than what sits there.
 */
export async function pressLanding(
  probe: LandingProbe | undefined,
  aimedAtElement: boolean,
  press: () => Promise<void>,
): Promise<void> {
  try {
    await press();
  } catch (error) {
    if (probe) await landing(probe);
    throw error;
  }
  if (!probe) return;
  const outcome = await landing(probe);
  if (outcome === "landed") return;
  throw new BrowserActionError(
    outcome === "elsewhere" && aimedAtElement ? "covered" : "not_hittable",
  );
}
