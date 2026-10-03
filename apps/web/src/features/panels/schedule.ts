/** Runs `callback` after `ms`; the result cancels it. Injected so tests run time by hand. */
export type Schedule = (callback: () => void, ms: number) => () => void;

export const schedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};
