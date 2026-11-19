import { poseAt, showsAt, type Pose } from "../../scripts/spade-story.ts";

/*
 * The walkthrough's scene as the server draws it: at the first feature, which is where the
 * page's script starts it too (scripts/spade-scene.ts), so nothing jumps when it takes over.
 */

/** Whether a piece shown in `span` starts hidden. */
export const offAtStart = (span: string): boolean => !showsAt(span, 0);

/** The pose a face planned as `plan` holds at the first feature. */
export const poseAtStart = (plan: string): Pose => poseAt(plan, 0);
