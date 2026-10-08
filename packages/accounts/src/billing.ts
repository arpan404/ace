import { z } from "zod";
import { object } from "./quota-decode.ts";

/** Only safe CLI status metadata is accepted. OAuth alone does not establish billing. */
export function reportedBilling(body: Record<string, unknown>) {
  const explicit = z.enum(["api", "subscription", "unknown"]).safeParse(body["billingMode"]).data;
  const method = body["authDetail"] ?? body["authMethod"] ?? body["authMode"];
  const billingMode =
    explicit ??
    (["API key", "api_key", "apiKey", "apikey", "api_key_helper"].includes(String(method))
      ? "api"
      : ["ChatGPT", "chatgpt", "chatgptAuthTokens", "claude.ai"].includes(String(method))
        ? "subscription"
        : method !== undefined
          ? "unknown"
          : undefined);
  const plan = z
    .string()
    .min(1)
    .max(128)
    .safeParse(body["planType"] ?? object(body["rateLimits"])["planType"]).data;
  return { billingMode, plan };
}
