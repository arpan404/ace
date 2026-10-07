import { cursorInstanceId } from "@ace/provider-kit/cursor-selection";
import { DelegationRequest } from "@ace/protocol";

/** Normalize legacy account references before admission, catalog lookup and durable receipts. */
export function delegationRequest(value: DelegationRequest): DelegationRequest {
  const request = DelegationRequest.parse(value);
  return request.provider === "cursor"
    ? {
        ...request,
        ...(request.accountId ? { accountId: cursorInstanceId(request.accountId) } : {}),
        ...(request.instanceId ? { instanceId: cursorInstanceId(request.instanceId) } : {}),
      }
    : request;
}
