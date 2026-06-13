"use no memo";

import {
  type PartialKeys,
  useVirtualizer,
  type ReactVirtualizer,
  type ReactVirtualizerOptions,
} from "@tanstack/react-virtual";

const useCompilerIsolatedVirtualizer = useVirtualizer;

type SafeVirtualizerOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
> = PartialKeys<
  ReactVirtualizerOptions<TScrollElement, TItemElement>,
  "observeElementRect" | "observeElementOffset" | "scrollToFn"
>;

export function useReactCompilerSafeVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: SafeVirtualizerOptions<TScrollElement, TItemElement>,
): ReactVirtualizer<TScrollElement, TItemElement> {
  "use no memo";
  return useCompilerIsolatedVirtualizer(options);
}
