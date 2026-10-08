import { useEffect, useEffectEvent, useRef } from "react";
import { useToast, type ToastApi } from "@/components/ui/toast.tsx";

/** Switching threads dismisses its confirmations, including replies that arrive after navigation. */
export function useThreadToast(threadId: string) {
  const toast = useToast();
  const active = useRef(threadId);
  const ids = useRef(new Set<string>());
  const dismiss = useEffectEvent((id: string) => toast.close(id));
  useEffect(() => {
    active.current = threadId;
    const owned = ids.current;
    return () => {
      active.current = "";
      for (const id of owned) dismiss(id);
      owned.clear();
    };
  }, [threadId]);
  return {
    add(options: Parameters<ToastApi["add"]>[0]) {
      if (active.current !== threadId) return;
      const owned = ids.current;
      const id = toast.add({
        ...options,
        onClose() {
          owned.delete(id);
          options.onClose?.();
        },
      });
      owned.add(id);
    },
  };
}
