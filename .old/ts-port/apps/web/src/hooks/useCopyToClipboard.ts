import * as React from "react";

function clearTimeoutRef(timeoutRef: { current: NodeJS.Timeout | null }) {
  if (timeoutRef.current) {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  React.useEffect(() => {
    onCopyRef.current = onCopy;
    onErrorRef.current = onError;
    timeoutRef.current = timeout;
  }, [onCopy, onError, timeout]);

  const copyToClipboard = (value: string, ctx: TContext): void => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      onErrorRef.current?.(new Error("Clipboard API unavailable."), ctx);
      return;
    }

    if (!value) return;

    navigator.clipboard.writeText(value).then(
      () => {
        clearTimeoutRef(timeoutIdRef);
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        if (onErrorRef.current) {
          onErrorRef.current(error, ctx);
        } else {
          console.error(error);
        }
      },
    );
  };

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      clearTimeoutRef(timeoutIdRef);
    };
  }, []);

  return { copyToClipboard, isCopied };
}
