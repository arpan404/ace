import {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
} from "react-native-reanimated";

const MAX_STAGGER_INDEX = 6;
const STAGGER_STEP_MS = 36;

export const layoutTransition = LinearTransition.springify().damping(18).stiffness(180);

export function enterSection(delay = 0) {
  return FadeInDown.duration(220).delay(delay);
}

export function enterSubtle(delay = 0) {
  return FadeIn.duration(180).delay(delay);
}

export function enterRow(index = 0) {
  return FadeInDown.duration(180).delay(Math.min(index, MAX_STAGGER_INDEX) * STAGGER_STEP_MS);
}

export const exitSubtle = FadeOut.duration(120);
export const exitRow = FadeOutDown.duration(120);
