import type { ReadinessView } from "@ace/ui-core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
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
 * Quiet sign-in actions behind a "…" button (Sign in again, Sign out), for something that works:
 * nothing about it asks for attention.
 */
export function SignInMenu(props: {
  /** "More for Codex": the button's accessible name. */
  label: string;
  items: readonly { label: string; target: SignInTarget }[];
}) {
  const signIn = useSignIn();
  if (!signIn || !props.items.length) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={DotsThreeIcon}
            label={props.label}
            size="sm"
            onPointerEnter={() => void preloadSignIn()}
          />
        }
      />
      <MenuContent align="end">
        {props.items.map((item) => (
          <MenuItem key={item.label} onClick={() => signIn(item.target)}>
            {item.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/**
 * What a provider's readiness (`readinessView`) offers: one prominent button only when it's
 * needed (Sign in while signed out, Reconnect while it needs attention), and the quieter
 * actions (Sign in again, Sign out) in a "…" menu.
 */
export function ReadinessActions(props: {
  provider: SignInTarget["provider"];
  name: string;
  view: ReadinessView;
  /** The page's one suggested step: its button is the primary one. */
  emphasis?: "primary" | "secondary" | undefined;
}) {
  const { provider, name, view } = props;
  const items = view.more
    .filter((action) => action !== view.primary)
    .map((action) =>
      action === "sign_out"
        ? { label: "Sign out", target: { provider, action: "logout" as const } }
        : { label: action === "reconnect" ? "Sign in again" : "Sign in", target: { provider } },
    );
  return (
    <>
      {view.primary && (
        <SignInButton
          variant={props.emphasis ?? "primary"}
          label={view.primary === "sign_in" ? `Sign in to ${name}` : `Reconnect ${name}`}
          target={{ provider }}
        >
          {view.primary === "sign_in" ? "Sign in" : "Reconnect"}
        </SignInButton>
      )}
      <SignInMenu label={`More for ${name}`} items={items} />
    </>
  );
}
