import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

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

/** Take over the screen's connection notice while this component is mounted. */
export function useClaimConnectionNotice(): void {
  const claim = useContext(ClaimContext);
  useEffect(() => claim?.(), [claim]);
}
