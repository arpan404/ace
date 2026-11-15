/** Setup's steps, in order. The route keeps the current one in `?step=`, so Back works. */
export const setupSteps = ["welcome", "agents", "project", "done"] as const;
export type SetupStep = (typeof setupSteps)[number];
