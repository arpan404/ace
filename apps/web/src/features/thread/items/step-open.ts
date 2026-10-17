import { createContext, use, useMemo, useState } from "react";

/*
 * Which of a work log's disclosures the reader opened, by step and group id rather than by where
 * they are drawn. A live log regroups as steps arrive (a lone step joins a group, a group grows),
 * which redraws its rows; what the reader opened stays open through it.
 */

interface OpenSteps {
  readonly open: ReadonlyMap<string, boolean>;
  set(id: string, open: boolean): void;
}

export const OpenStepsContext = createContext<OpenSteps | undefined>(undefined);

/** One log's open disclosures, for `OpenStepsContext`. */
export function useOpenSteps(): OpenSteps {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  return useMemo(
    () => ({
      open,
      set: (id, value) => setOpen((current) => new Map(current).set(id, value)),
    }),
    [open],
  );
}

/** Whether the reader opened a step (undefined until they toggle it), kept by its item id. */
export function useStepOpen(itemId: string): [boolean | undefined, (open: boolean) => void] {
  const store = use(OpenStepsContext);
  const [local, setLocal] = useState<boolean>();
  if (!store) return [local, setLocal];
  return [store.open.get(`step:${itemId}`), (open) => store.set(`step:${itemId}`, open)];
}

/**
 * Whether a group is open: as the reader left it, else open while it holds a step they opened
 * (a step they expanded before more steps joined it stays in view, expanded).
 */
export function useGroupOpen(
  key: string,
  ids: readonly string[],
): [boolean, (open: boolean) => void] {
  const store = use(OpenStepsContext);
  const [local, setLocal] = useState(false);
  if (!store) return [local, setLocal];
  const chosen = store.open.get(`group:${key}`);
  return [
    chosen ?? ids.some((id) => store.open.get(`step:${id}`) === true),
    (open) => store.set(`group:${key}`, open),
  ];
}
