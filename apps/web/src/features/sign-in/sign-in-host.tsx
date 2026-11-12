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
import { deferredPart } from "@/lib/deferred-part.ts";
import type { LoginController, SignInTarget } from "./login-controller.ts";

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
/** Antigravity asks how to sign in before its sign-in starts. */
const MethodDialog = deferredComponent(() =>
  import("./antigravity-method.tsx").then((module) => module.AntigravityMethodDialog),
);
/** An Antigravity sign-in without a chosen method asks for one first; sign-out never does. */
const needsMethod = (target: SignInTarget) =>
  target.provider === "antigravity" &&
  target.action !== "logout" &&
  !target.signIn &&
  !target.newAccount;

/** The login itself loads with the dialog, the first time someone signs in. */
const controller = deferredPart(() =>
  import("./login-controller.ts").then((module) => module.LoginController),
);

/** Start loading the dialog (a Sign in button hovered or focused). */
export const preloadSignIn = (): Promise<unknown> =>
  Promise.all([SignInDialog.preload(), controller.load()]);

/**
 * The one sign-in dialog. Opening it starts the login at once (from the click, so a remount
 * never starts a second one); closing it cancels a login that is still running.
 */
export function SignInHost(props: { children: ReactNode }) {
  const client = useClient();
  const [login, setLogin] = useState<LoginController>();
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState<SignInTarget>();
  // The running login, outside state: starting and cancelling are effects of a click, and
  // state updaters may run twice.
  const running = useRef<LoginController | undefined>(undefined);
  // The latest open or close: a login whose code arrives after another click, or after the
  // dialog closed, never starts.
  const request = useRef(0);
  const begin = useCallback(
    (target: SignInTarget) => {
      running.current?.dispose();
      running.current = undefined;
      const asked = ++request.current;
      const start = (Controller: typeof LoginController) => {
        if (asked !== request.current) return;
        const next = new Controller(client, target);
        running.current = next;
        setLogin(next);
      };
      const loaded = controller.current();
      if (loaded) return start(loaded);
      // A failed load closes the dialog, as a dialog whose own code failed shows nothing; the
      // next click loads again.
      controller.load().then(start, () => {
        if (asked === request.current) setOpen(false);
      });
    },
    [client],
  );
  const show = useCallback<OpenSignIn>(
    (target) => {
      if (needsMethod(target)) {
        request.current++;
        running.current?.dispose();
        setOpen(false);
        setChoosing(target);
        return;
      }
      setChoosing(undefined);
      begin(target);
      setOpen(true);
    },
    [begin],
  );
  const close = useCallback(() => {
    request.current++;
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
      {choosing && (
        <LocalBoundary label="sign in" fallback={null}>
          <Suspense fallback={null}>
            <MethodDialog.Component
              instance={choosing.instance}
              onClose={() => setChoosing(undefined)}
              onContinue={(signIn) => show({ ...choosing, signIn })}
            />
          </Suspense>
        </LocalBoundary>
      )}
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
