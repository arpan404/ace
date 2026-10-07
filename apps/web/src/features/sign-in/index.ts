/**
 * Signing in to providers from ace: the dialog that runs a provider CLI's own sign-in (or
 * sign-out), opened from Settings, setup, the model picker or a failed turn.
 */
export { SignInHost, preloadSignIn, useSignIn, type OpenSignIn } from "./sign-in-host.tsx";
export type { SignInTarget } from "./login-controller.ts";
export { SignInNotice } from "./sign-in-notice.tsx";
export { ReadinessAction, SignInButton } from "./sign-in-button.tsx";
