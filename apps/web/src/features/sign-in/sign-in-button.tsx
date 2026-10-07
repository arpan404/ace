import type { ReadinessView } from "@ace/ui-core";
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

/**
 * The one action a provider's readiness (`readinessView`) asks for, if any: Sign in while
 * signed out, Reconnect while it needs attention. Nothing for a provider that works.
 */
export function ReadinessAction(
  props: Omit<ButtonProps, "variant"> & {
    provider: SignInTarget["provider"];
    name: string;
    view: ReadinessView;
    /** The page's one suggested step is primary; elsewhere the button is quieter. */
    emphasis?: "primary" | "secondary" | undefined;
  },
) {
  const { provider, name, view } = props;
  if (!view.primary) return null;
  const signIn = view.primary === "sign_in";
  return (
    <SignInButton
      size={props.size}
      className={props.className}
      variant={props.emphasis ?? "primary"}
      label={signIn ? `Sign in to ${name}` : `Reconnect ${name}`}
      target={{ provider }}
    >
      {signIn ? "Sign in" : "Reconnect"}
    </SignInButton>
  );
}
