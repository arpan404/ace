import { contextTokens } from "@ace/provider-kit/cursor-selection";

type Param = { id: string; value: string };
type Variant = { displayName: string; isDefault?: boolean | undefined; params: Param[] };

const contextOf = (variant: Variant) =>
  contextTokens(variant.params.find((param) => param.id === "context")?.value);

/**
 * The variants a local SDK run can select. A larger context than the model's standard one is
 * Max Mode, which `ModelSelection` can't request and Cursor rejects without, so those variants
 * are dropped. This also keeps models such as Claude Opus 4.8 (40 variants: thinking × context ×
 * effort × fast) inside the catalog's tier and row limits.
 *
 * When the listed default is a dropped Max Mode variant, the default becomes the kept variant that
 * agrees with it on the most other parameters.
 */
export function selectableVariants<T extends Variant>(variants: readonly T[]): T[] {
  const contexts = variants.flatMap((variant) => contextOf(variant) ?? []);
  if (!contexts.length) return [...variants];
  const standard = Math.min(...contexts);
  const kept = variants.filter((variant) => (contextOf(variant) ?? standard) === standard);
  const listed = variants.find((variant) => variant.isDefault);
  if (!listed || kept.includes(listed)) return kept;
  const agreement = (variant: T) =>
    variant.params.filter((param) =>
      listed.params.some((other) => other.id === param.id && other.value === param.value),
    ).length;
  let fallback: T | undefined;
  for (const variant of kept)
    if (!fallback || agreement(variant) > agreement(fallback)) fallback = variant;
  return kept.map((variant) => Object.assign({}, variant, { isDefault: variant === fallback }));
}
