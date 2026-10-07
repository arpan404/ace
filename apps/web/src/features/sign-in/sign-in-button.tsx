import type { ReadinessAction } from "@ace/ui-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { SignInTarget } from "./login-controller.ts";
import { preloadSignIn, useSignIn } from "./sign-in-host.tsx";

type ButtonProps = Pick<React.ComponentProps<typeof Button>, "variant" | "size" | "className">;

/**
 * A button that opens the sign-in dialog for `target`; nothing outside the app shell, where
 * there's no dialog to open. Hovering or focusing it starts loading the dialog.
 */
export function SignInButton(
  props: ButtonProps & { target: SignInTarget; label?: string; children: ReactNode },
) {
  const signIn = useSignIn();
  if (!signIn) return null;
  return (
    <Button
      size={props.size ?? "sm"}
      variant={props.variant ?? "secondary"}
      className={props.className}
      aria-label={props.label}
      onPointerEnter={() => void preloadSignIn()}
      onFocus={() => void preloadSignIn()}
      onClick={() => signIn(props.target)}
    >
      {props.children}
    </Button>
  );
}

const words: Record<Exclude<ReadinessAction, "install">, string> = {
  sign_in: "Sign in",
  reconnect: "Reconnect",
  sign_out: "Sign out",
};

/**
 * The action a provider's readiness offers (`readinessView`): Sign in, Reconnect or Sign out,
 * named for the provider ("Sign in to Codex"). Nothing for install, which is a command to run.
 */
export function ReadinessButton(
  props: ButtonProps & {
    provider: SignInTarget["provider"];
    name: string;
    action: ReadinessAction | undefined;
  },
) {
  const { action, name } = props;
  if (!action || action === "install") return null;
  const label =
    action === "sign_in"
      ? `Sign in to ${name}`
      : action === "reconnect"
        ? `Reconnect ${name}`
        : `Sign out of ${name}`;
  return (
    <SignInButton
      size={props.size}
      variant={props.variant ?? (action === "sign_out" ? "ghost" : "secondary")}
      className={props.className}
      label={label}
      target={{
        provider: props.provider,
        ...(action === "sign_out" ? { action: "logout" as const } : {}),
      }}
    >
      {words[action]}
    </SignInButton>
  );
}
