/** Setup's steps, in order. The route keeps the current one in `?step=`, so Back works. */
export const setupSteps = ["welcome", "agents", "project", "done"] as const;
export type SetupStep = (typeof setupSteps)[number];

/** Each step's name, as the step list reads it aloud. */
export const stepNames: Record<SetupStep, string> = {
  welcome: "Welcome",
  agents: "Agents",
  project: "Project",
  done: "Done",
};
