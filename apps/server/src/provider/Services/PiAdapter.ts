import type { ProviderAdapterError } from "../Errors.ts";
import { createProviderAdapterTag } from "./createProviderAdapterTag.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "pi";
}

export class PiAdapter extends createProviderAdapterTag<PiAdapter, PiAdapterShape>(
  "ace/provider/Services/PiAdapter",
) {}
