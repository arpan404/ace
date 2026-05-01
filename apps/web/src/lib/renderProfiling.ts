let profileSequence = 0;

function readProfilingFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return (
      window.localStorage.getItem("ace:profile-rendering") === "1" ||
      new URLSearchParams(window.location.search).has("profileRender")
    );
  } catch {
    return false;
  }
}

export function isRenderProfilingEnabled(): boolean {
  return readProfilingFlag();
}

export function measureRenderWork<T>(name: string, work: () => T): T {
  if (!isRenderProfilingEnabled() || typeof performance === "undefined") {
    return work();
  }

  const sequence = profileSequence;
  profileSequence = (profileSequence + 1) % Number.MAX_SAFE_INTEGER;
  const startMark = `${name}:start:${sequence}`;
  const endMark = `${name}:end:${sequence}`;
  performance.mark(startMark);
  try {
    return work();
  } finally {
    performance.mark(endMark);
    performance.measure(name, startMark, endMark);
    performance.clearMarks(startMark);
    performance.clearMarks(endMark);
  }
}

export function recordReactRenderProfile(
  name: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
): void {
  if (!isRenderProfilingEnabled() || typeof performance === "undefined") {
    return;
  }

  const safeDuration = Number.isFinite(actualDuration) ? Math.max(actualDuration, 0) : 0;
  try {
    performance.measure(`${name}:${phase}`, {
      start: Math.max(performance.now() - safeDuration, 0),
      duration: safeDuration,
    });
  } catch {
    const markName = `${name}:${phase}:${profileSequence}`;
    profileSequence = (profileSequence + 1) % Number.MAX_SAFE_INTEGER;
    performance.mark(markName);
  }
}
