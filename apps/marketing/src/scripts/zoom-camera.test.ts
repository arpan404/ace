import { describe, expect, it } from "vitest";
import {
  between,
  captionAt,
  frame,
  legAt,
  project,
  shotOrder,
  storyAt,
  dialSeats,
  teamDial,
  type Insets,
  type Rect,
  type Size,
} from "./zoom-camera.ts";

const insets: Insets = { top: 88, right: 40, bottom: 170, left: 40 };
const stages: Size[] = [
  { width: 390, height: 760 },
  { width: 1024, height: 720 },
  { width: 1920, height: 1080 },
];
const subjects: Rect[] = [
  { x: 520, y: 700, width: 720, height: 110 },
  { x: 0, y: 0, width: 1352, height: 880 },
  { x: -480, y: 0, width: 2640, height: 880 },
];

/** Where a subject lands on the stage under a camera. */
function shown(rect: Rect, camera: { scale: number; x: number; y: number }) {
  const start = project(camera, rect);
  const end = project(camera, { x: rect.x + rect.width, y: rect.y + rect.height });
  return { left: start.x, top: start.y, right: end.x, bottom: end.y };
}

describe("framing a shot", () => {
  it("keeps the whole subject clear of the header and captions on every screen", () => {
    for (const stage of stages) {
      for (const rect of subjects) {
        const box = shown(rect, frame({ rect, insets }, stage));
        expect(box.left).toBeGreaterThanOrEqual(insets.left - 0.01);
        expect(box.top).toBeGreaterThanOrEqual(insets.top - 0.01);
        expect(box.right).toBeLessThanOrEqual(stage.width - insets.right + 0.01);
        expect(box.bottom).toBeLessThanOrEqual(stage.height - insets.bottom + 0.01);
      }
    }
  });

  it("does not blow a small subject up past its largest size", () => {
    const camera = frame({ rect: subjects[0], insets, maxScale: 1 }, stages[2]);
    expect(camera.scale).toBe(1);
  });

  it("lets a wide subject run off the far edge instead of shrinking past reading size", () => {
    const rect = subjects[1];
    const box = shown(rect, frame({ rect, insets, minScale: 0.6 }, stages[0]));
    expect(box.left).toBeCloseTo(insets.left);
    expect(box.right).toBeGreaterThan(stages[0].width);
  });
});

describe("moving between shots", () => {
  const stage = stages[1];
  const near = frame({ rect: subjects[0], insets }, stage);
  const far = frame({ rect: subjects[2], insets }, stage);

  it("starts on the first shot and ends on the second", () => {
    expect(between(near, far, 0, stage)).toEqual(near);
    expect(between(near, far, 1, stage)).toEqual(far);
  });

  it("zooms steadily: equal steps of the move change the size by the same ratio", () => {
    const quarter = between(near, far, 0.25, stage).scale;
    const half = between(near, far, 0.5, stage).scale;
    expect(half / quarter).toBeCloseTo(quarter / near.scale);
  });

  it("keeps the subject it is leaving on screen for the first part of a pull back", () => {
    const box = shown(subjects[0], between(near, far, 0.3, stage));
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(stage.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(stage.height);
  });
});

describe("the scroll through the story", () => {
  const shots = shotOrder.length;

  it("rests on the first shot before the camera moves, and on the last after it arrives", () => {
    expect(legAt(0, shots).at).toBe(0);
    expect(legAt(0.02, shots).at).toBe(0);
    expect(legAt(0.99, shots).at).toBe(shots - 1);
    expect(legAt(1, shots).at).toBe(shots - 1);
  });

  it("never moves backwards as the page scrolls down", () => {
    let last = -1;
    for (let step = 0; step <= 500; step++) {
      const { at } = legAt(step / 500, shots);
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });

  it("is on the same shot either side of the point where one move hands over to the next", () => {
    const edge = 2 / (shots - 1);
    expect(legAt(edge - 1e-6, shots).at).toBeCloseTo(2);
    expect(legAt(edge + 1e-6, shots).at).toBeCloseTo(2);
  });

  it("shows the caption of whichever shot the camera is nearer to", () => {
    expect(captionAt({ from: 1, to: 2, t: 0.2, at: 1.2 })).toBe(1);
    expect(captionAt({ from: 1, to: 2, t: 0.8, at: 1.8 })).toBe(2);
  });
});

describe("what has happened in the story", () => {
  const moments = Array.from({ length: 501 }, (_, step) => storyAt((step / 500) * 5));

  it("starts with only the prompt in the composer", () => {
    expect(storyAt(0)).toMatchObject({ sent: false, lines: 0, agentsOpen: false, done: false });
  });

  it("lists the agents only after the thread has handed work to them", () => {
    for (const moment of moments) {
      if (moment.agentsOpen) expect(moment.lines).toBe(4);
    }
  });

  it("asks for an approval before showing it allowed", () => {
    const asked = moments.findIndex((moment) => moment.approval === "asked");
    const allowed = moments.findIndex((moment) => moment.approval === "allowed");
    expect(asked).toBeGreaterThan(-1);
    expect(allowed).toBeGreaterThan(asked);
  });

  it("shows the thread as done only at the end, after the approval is answered", () => {
    for (const moment of moments) {
      if (moment.done) expect(moment.approval).toBe("allowed");
    }
    expect(storyAt(5).done).toBe(true);
    expect(storyAt(4.5).done).toBe(false);
  });
});

describe("the wheel of agents beside the composer", () => {
  const chip = { width: 172, height: 38 };
  const composer = { x: 138, y: 525, width: 800, height: 140 };
  const stage = { width: 1440, height: 900 };
  const dial = teamDial(composer, stage, 138, chip);

  it("stands the chosen agent level with the composer, clear of it and of the edge", () => {
    expect(dial).toBeDefined();
    if (!dial) return;
    const chosen = dialSeats(dial, 6, 2, chip)[2];
    expect(chosen?.y).toBeCloseTo(composer.y + composer.height / 2 - chip.height / 2);
    expect(chosen?.x).toBeGreaterThan(composer.x + composer.width);
    expect((chosen?.x ?? 0) + chip.width).toBeLessThanOrEqual(stage.width - 138);
    expect(chosen).toMatchObject({ opacity: 1, tilt: 0 });
  });

  it("stacks the neighbours straight above and below, without overlap, leaning back and fading", () => {
    if (!dial) return;
    const seats = dialSeats(dial, 6, 0, chip);
    const [chosen, below, , , , above] = seats;
    expect(below?.x).toBe(chosen?.x);
    expect(above?.x).toBe(chosen?.x);
    expect((below?.y ?? 0) - (chosen?.y ?? 0)).toBeGreaterThanOrEqual(chip.height);
    expect((chosen?.y ?? 0) - (above?.y ?? 0)).toBeGreaterThanOrEqual(chip.height);
    expect(below?.opacity).toBeLessThan(1);
    expect(below?.tilt).toBe(-(above?.tilt ?? 0));
    expect(seats[3]?.opacity).toBe(0);
  });

  it("keeps the same seats whoever is chosen, so choosing only turns the wheel", () => {
    if (!dial) return;
    const first = dialSeats(dial, 6, 0, chip);
    const later = dialSeats(dial, 6, 4, chip);
    expect(later[4]).toEqual(first[0]);
    expect(later[5]).toEqual(first[1]);
    expect(later[3]).toEqual(first[5]);
  });

  it("is left out when there is no room beside the composer", () => {
    const narrow = { x: 20, y: 400, width: 350, height: 110 };
    expect(teamDial(narrow, { width: 390, height: 844 }, 20, chip)).toBeUndefined();
    const filled = { x: 40, y: 500, width: 900, height: 120 };
    expect(teamDial(filled, { width: 1024, height: 768 }, 40, chip)).toBeUndefined();
  });
});
