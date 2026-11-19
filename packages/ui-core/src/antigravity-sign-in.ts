import { AntigravitySignIn, type AntigravitySignInMethod } from "@ace/protocol";

/** How an Antigravity account can sign in, in the words every client shows. Google comes first. */
export const antigravitySignInMethods: readonly {
  method: AntigravitySignInMethod;
  label: string;
  /** Needs a Google Cloud project and location. */
  cloud: boolean;
}[] = [
  { method: "google", label: "Google account", cloud: false },
  { method: "enterprise", label: "Gemini Enterprise", cloud: true },
  { method: "agent_platform", label: "Agent Platform", cloud: true },
];

/** The label for how an account signs in. */
export function antigravitySignInLabel(method: AntigravitySignInMethod): string {
  return antigravitySignInMethods.find((entry) => entry.method === method)?.label ?? method;
}

export interface AntigravityMethodDraft {
  method: AntigravitySignInMethod;
  project: string;
  location: string;
}

export const googleSignIn: AntigravityMethodDraft = { method: "google", project: "", location: "" };

/** The sign-in to ask for, or what to fix first. */
export function antigravitySignIn(
  draft: AntigravityMethodDraft,
): { signIn: AntigravitySignIn } | { problem: string } {
  const parsed = AntigravitySignIn.safeParse(
    draft.method === "google"
      ? { method: "google" }
      : { method: draft.method, project: draft.project.trim(), location: draft.location.trim() },
  );
  if (parsed.success) return { signIn: parsed.data };
  const project = parsed.error.issues.some((issue) => issue.path[0] === "project");
  return {
    problem: project
      ? "Enter the Google Cloud project ID, like my-project-123."
      : "Enter the location, like global, us or us-central1.",
  };
}
