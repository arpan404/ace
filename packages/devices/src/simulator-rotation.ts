/** Degrees clockwise a viewer turns a picture to show it upright. */
export type FrameRotation = 0 | 90 | 180 | 270;

/**
 * serve-sim's pictures and touch coordinates stay in the simulator's portrait framebuffer when
 * the device turns; only the orientation it announces changes. This maps that announced
 * orientation to the turn a viewer needs. Checked on an iOS 18.5 iPhone 16 with serve-sim
 * 0.1.47: `landscape_left` reads upright after 90° clockwise, `landscape_right` after 270°.
 * Unknown names keep the picture as it is.
 */
export function simulatorRotation(orientation: string): FrameRotation {
  switch (orientation) {
    case "landscape_left":
      return 90;
    case "portrait_upside_down":
      return 180;
    case "landscape_right":
      return 270;
    default:
      return 0;
  }
}

/**
 * The orientation to turn a Simulator to so it matches what serve-sim announced: an unknown
 * name is shown upright (`simulatorRotation` gives 0), so the device is turned upright too.
 */
export function knownOrientation(orientation: string): string {
  return simulatorRotation(orientation) === 0 ? "portrait" : orientation;
}
