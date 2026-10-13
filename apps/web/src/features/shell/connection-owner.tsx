import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

type Claim = () => () => void;

const ClaimContext = createContext<Claim | undefined>(undefined);

/**
 * Who announces connection trouble on a screen. The header does, unless a surface inside the
 * screen (the thread composer's strip) has claimed it: trouble is said once, by one surface.
 */
export function ConnectionOwner(props: { children(headerOwnsIt: boolean): ReactNode }) {
  const [claims, setClaims] = useState(0);
  const claim = useCallback<Claim>(() => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  return (
    <ClaimContext.Provider value={claim}>{props.children(claims === 0)}</ClaimContext.Provider>
  );
}

/** Take over the screen's connection notice while `active`: this component says it instead. */
export function useClaimConnectionNotice(active: boolean): void {
  const claim = useContext(ClaimContext);
  // Before paint: the header never flashes a notice the strip is about to say.
  useLayoutEffect(() => (active ? claim?.() : undefined), [claim, active]);
}
