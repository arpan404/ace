import { expect, test } from "vitest";
import {
  spadeEye,
  spadeEyes,
  spadeLookFromPointer,
  spadePupilAt,
  spadePupilForSize,
  spadeRestLook,
} from "./spade-look.ts";

const left = spadeEyes[0];
if (!left) throw new Error("Spade has two eyes");

test("a pointer far to the right looks right without leaving the eye", () => {
  const { pupil, pad } = spadePupilForSize(20);
  const look = spadeLookFromPointer({ left: 0, top: 0, width: 20, height: 20 }, { x: 200, y: 10 });
  expect(look.dx).toBeGreaterThan(0);
  const at = spadePupilAt(left, pupil, pad, look);
  expect(at.x).toBeGreaterThan(left.x);
  const ax = spadeEye.rx - pupil.rx - pad;
  const ay = spadeEye.ry - pupil.ry - pad;
  const inside =
    ((at.x - left.x) * (at.x - left.x)) / (ax * ax) +
    ((at.y - left.y) * (at.y - left.y)) / (ay * ay);
  expect(inside).toBeLessThanOrEqual(1.000001);
});

test("with no target the pupils rest low and a hair left", () => {
  const { pupil, pad } = spadePupilForSize(20);
  const at = spadePupilAt(left, pupil, pad, undefined);
  expect(at.x).toBeLessThan(left.x);
  expect(at.y).toBeGreaterThan(left.y);
  expect(at).toEqual(spadePupilAt(left, pupil, pad, spadeRestLook));
});
