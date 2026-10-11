import { useEffect, useRef, useState } from "react";

/** Shared clipboard feedback; the UI shell owns the bounded feedback timer. */
export function useCopy(): { copied: boolean; copy(text: string): void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    copied,
    copy(text) {
      void navigator.clipboard?.writeText(text).then(
        () => {
          clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1500);
        },
        () => setCopied(false),
      );
    },
  };
}
