import { useEffect, useRef, useState } from "react";

/**
 * Clipboard feedback shown on the control itself: `copied` holds for a moment after a write
 * lands. A failed write calls `onFail`, the only case worth a toast.
 */
export function useCopy(onFail?: (error: unknown) => void): {
  copied: boolean;
  copy(text: string): void;
  /** The same feedback for any other clipboard write, such as an image. */
  track(write: Promise<unknown>): void;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fail = useRef(onFail);
  useEffect(() => {
    fail.current = onFail;
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  const track = (write: Promise<unknown>) =>
    void write.then(
      () => {
        clearTimeout(timer.current);
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      (error: unknown) => {
        setCopied(false);
        fail.current?.(error);
      },
    );
  return {
    copied,
    track,
    copy: (text) =>
      track(navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("No clipboard"))),
  };
}
