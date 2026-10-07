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

/** A "Manage" menu entry: a sign-in to open, or something of the caller's (Show details). */
export type ManageItem =
  | { label: string; target: SignInTarget }
  | { label: string; onSelect(): void };

/**
 * The one quiet control for something that works: a "…" button ("Manage Codex") whose menu
 * holds Sign in again, Sign out and the caller's own entries. Nothing in it asks for attention.
 */
export function ManageMenu(props: {
  /** "Manage Codex": the button's accessible name. */
  label: string;
  items: readonly ManageItem[];
}) {
  const signIn = useSignIn();
  const items = props.items.filter((item) => "onSelect" in item || signIn);
  if (!items.length) return null;
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
        {items.map((item) => (
          <MenuItem
            key={item.label}
            onClick={() => ("onSelect" in item ? item.onSelect() : signIn?.(item.target))}
          >
            {item.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/**
 * What a provider's readiness (`readinessView`) offers: one prominent button only when it's
 * needed (Sign in while signed out, Reconnect while it needs attention), and everything else
 * (Sign in again or Connect another provider, Sign out, the caller's `extra` entries) in one
 * "Manage" menu.
 */
export function ReadinessActions(props: {
  provider: SignInTarget["provider"];
  name: string;
  view: ReadinessView;
  /** The page's one suggested step: its button is the primary one. */
  emphasis?: "primary" | "secondary" | undefined;
  /** Entries of the caller's, first in the menu (Show details). */
  extra?: readonly ManageItem[] | undefined;
}) {
  const { provider, name, view } = props;
  const signInWords = view.upstreams ? "Connect another provider" : "Sign in again";
  const items: ManageItem[] = [
    ...(props.extra ?? []),
    ...view.more
      .filter((action) => action !== view.primary)
      .map((action) =>
        action === "sign_out"
          ? { label: "Sign out", target: { provider, action: "logout" as const } }
          : { label: signInWords, target: { provider } },
      ),
  ];
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
      <ManageMenu label={`Manage ${name}`} items={items} />
    </>
  );
}
