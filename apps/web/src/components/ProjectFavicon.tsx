import { FolderIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveServerUrl } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Set<string>();
const PROJECT_FAVICON_RETRY_DELAYS_MS = [300, 900, 1800] as const;

export function ProjectFavicon({ cwd, className }: { cwd: string; className?: string }) {
  const baseSrc = resolveServerUrl({
    protocol: "http",
    pathname: "/api/project-favicon",
    searchParams: { cwd },
  });
  const retryTimeoutRef = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(baseSrc) ? "loaded" : "loading",
  );
  const src = useMemo(() => {
    if (attempt === 0) {
      return baseSrc;
    }
    const url = new URL(baseSrc);
    url.searchParams.set("attempt", String(attempt));
    return url.toString();
  }, [attempt, baseSrc]);

  useEffect(() => {
    setAttempt(0);
    setStatus(loadedProjectFaviconSrcs.has(baseSrc) ? "loaded" : "loading");
  }, [baseSrc]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon className={`size-3.5 shrink-0 text-muted-foreground/50 ${className ?? ""}`} />
      ) : null}
      <img
        src={src}
        alt=""
        loading="eager"
        decoding="sync"
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${className ?? ""}`}
        onLoad={() => {
          if (retryTimeoutRef.current !== null) {
            window.clearTimeout(retryTimeoutRef.current);
            retryTimeoutRef.current = null;
          }
          loadedProjectFaviconSrcs.add(baseSrc);
          setStatus("loaded");
        }}
        onError={() => {
          if (status === "loaded") {
            return;
          }
          const nextDelay = PROJECT_FAVICON_RETRY_DELAYS_MS[attempt];
          if (nextDelay === undefined) {
            setStatus("error");
            return;
          }
          setStatus("loading");
          retryTimeoutRef.current = window.setTimeout(() => {
            setAttempt((current) => current + 1);
          }, nextDelay);
        }}
      />
    </>
  );
}
