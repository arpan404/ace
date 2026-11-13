import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { BotFaceState } from "@ace/ui-core/bot-face";
import { useFaceState } from "./use-face-state.ts";

for (const active of ["working", "thinking", "needs-you"] as const) {
  test(`${active} going unavailable rests without confirming completion, even after reconnect`, () => {
    const { result, rerender } = renderHook(
      ({ live }: { live: BotFaceState | null }) => useFaceState(live),
      { initialProps: { live: active as BotFaceState | null } },
    );
    rerender({ live: null });
    expect(result.current).toBe("idle");
    rerender({ live: "idle" });
    expect(result.current).toBe("idle");
    act(() => rerender({ live: active }));
    rerender({ live: "idle" });
    expect(result.current).toBe("done");
  });
}
