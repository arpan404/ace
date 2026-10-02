import type { ProviderAdapter, Translator } from "@ace/engine-api";
import { ProviderKind } from "@ace/protocol";
import { z } from "zod";

const callable = <T>() => z.custom<T>((value) => typeof value === "function", "must be a function");
const adapterSchema = z.object({
  provider: ProviderKind,
  capabilities: callable<ProviderAdapter["capabilities"]>(),
  createTranslator: callable<ProviderAdapter["createTranslator"]>(),
  openSession: callable<ProviderAdapter["openSession"]>(),
});
const translatorSchema = z.object({
  translate: callable<Translator["translate"]>(),
  tick: callable<Translator["tick"]>(),
});
const moduleSchema = z.object({ default: z.unknown().optional(), adapter: z.unknown().optional() });

/** Validate imported code's contract before replay, preserving each method's receiver. */
export function readAdapterModule(
  loaded: unknown,
  name: string,
): Pick<ProviderAdapter, "provider" | "createTranslator"> {
  try {
    const module = moduleSchema.parse(loaded);
    const original = module.default ?? module.adapter;
    if (!original) throw new Error("must export a default ProviderAdapter or named adapter");
    const adapter = adapterSchema.parse(original);
    return {
      provider: adapter.provider,
      createTranslator(init) {
        try {
          const originalTranslator: unknown = adapter.createTranslator.call(original, init);
          const translator = translatorSchema.parse(originalTranslator);
          return {
            translate: (frame, now) => translator.translate.call(originalTranslator, frame, now),
            tick: (now) => translator.tick.call(originalTranslator, now),
          };
        } catch (error) {
          throw new Error(
            `adapter module ${name}: createTranslator returned an invalid translator: ${String(error)}`,
            { cause: error },
          );
        }
      },
    };
  } catch (error) {
    throw new Error(`adapter module ${name}: ${String(error)}`, { cause: error });
  }
}
