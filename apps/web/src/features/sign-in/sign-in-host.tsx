import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { useClient } from "@ace/client-react";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { LoginController, type SignInTarget } from "./login-controller.ts";

/** Open the sign-in dialog for a provider (or one of its upstreams), or sign out of it. */
export type OpenSignIn = (target: SignInTarget) => void;

const SignInContext = createContext<OpenSignIn | undefined>(undefined);

/**
 * Opens the sign-in dialog from anywhere under the app shell; undefined outside it (a part
 * rendered on its own), where callers leave their Sign in action out.
 */
export function useSignIn(): OpenSignIn | undefined {
  return useContext(SignInContext);
}

/** The dialog's code loads the first time someone signs in. */
const SignInDialog = deferredComponent(() =>
  import("./sign-in-dialog.tsx").then((module) => module.SignInDialog),
);
/** Start loading the dialog (a Sign in button hovered or focused). */
export const preloadSignIn = (): Promise<unknown> => SignInDialog.preload();

/**
 * The one sign-in dialog. Opening it starts the login at once (from the click, so a remount
 * never starts a second one); closing it cancels a login that is still running.
 */
export function SignInHost(props: { children: ReactNode }) {
  const client = useClient();
  const [login, setLogin] = useState<LoginController>();
  const [open, setOpen] = useState(false);
  // The running login, outside state: starting and cancelling are effects of a click, and
  // state updaters may run twice.
  const running = useRef<LoginController | undefined>(undefined);
  const begin = useCallback(
    (target: SignInTarget) => {
      running.current?.dispose();
      const next = new LoginController(client, target);
      running.current = next;
      setLogin(next);
    },
    [client],
  );
  const show = useCallback<OpenSignIn>(
    (target) => {
      begin(target);
      setOpen(true);
    },
    [begin],
  );
  const close = useCallback(() => {
    setOpen(false);
    running.current?.dispose();
  }, []);
  const retry = useCallback(() => {
    const before = running.current;
    if (before) begin(before.target);
  }, [begin]);
  useEffect(() => () => running.current?.dispose(), []);
  return (
    <SignInContext.Provider value={show}>
      {props.children}
      {login && (
        <LocalBoundary label="sign in" fallback={null}>
          <Suspense fallback={null}>
            <SignInDialog.Component login={login} open={open} onClose={close} onRetry={retry} />
          </Suspense>
        </LocalBoundary>
      )}
    </SignInContext.Provider>
  );
}
