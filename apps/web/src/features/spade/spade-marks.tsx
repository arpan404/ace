import { serviceInfo } from "@ace/ui-core";
import type { SpadeEndpoint } from "@ace/ui-core/spade-chat";
import { BrandMark, type BrandMarkProps } from "@/components/ui/provider-icons.tsx";

/**
 * The maker's mark for one of Spade's providers: its preset's (`opencode-go`, `openai`, a
 * ChatGPT sign-in's `openai`), or for one added by its address, the service its id names
 * (`openrouter`, `ollama`). One with no mark of its own gets ace's neutral glyph, never a
 * lookalike. Which mark stands for which service is `serviceInfo`, shared with ace's providers.
 */
export function SpadeProviderMark(
  props: BrandMarkProps & {
    account: Pick<SpadeEndpoint, "id" | "provider">;
    name: string;
  },
) {
  const { account, name, ...mark } = props;
  const brand = serviceInfo(account.provider ?? account.id).brand;
  return <BrandMark {...mark} choose={() => ({ brand, label: name })} fallbackLabel={name} />;
}

/**
 * A model's mark: its family's (Claude, GPT, Kimi, DeepSeek…) wherever it is served, so a router
 * like OpenRouter shows whose model each is; else the provider's own.
 */
export function SpadeModelMark(
  props: BrandMarkProps & {
    model: { id: string; name: string };
    account: Pick<SpadeEndpoint, "id" | "provider">;
  },
) {
  const { model, account, ...mark } = props;
  const own = serviceInfo(account.provider ?? account.id).brand;
  return (
    <BrandMark
      {...mark}
      choose={(tables) => ({
        brand: (tables.modelFamily(model.id) ?? tables.modelFamily(model.name))?.brand ?? own,
        label: model.name,
      })}
      fallbackLabel={model.name}
    />
  );
}
