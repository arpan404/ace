/*
 * ace accounts in the app (ADR 0100, 0111): the window's ace session, the machines on the
 * account beside the paired ones, the machine code prompt, and a machine's account settings.
 */
export {
  AceAccountBackendContext,
  AceAccountProvider,
  useAceAccount,
  useAceAccountStore,
} from "./account-context.tsx";
export type { AceAccountBackend, AceAccountStore } from "./session-store.ts";
export { accountMachineLists, platformName, type AccountMachine } from "./account-machines.ts";
export { useAccountMachines } from "./use-account-machines.ts";
export { useAccountPicture } from "./use-account-picture.ts";
export { AccountMachineRow } from "./account-machine-row.tsx";
export { MachineCodePrompt, type CodeGate } from "./machine-code-prompt.tsx";
export {
  AccountMachineConnectorContext,
  type AccountMachineConnector,
  type AccountMachineConnection,
  type AccountMachineState,
} from "./machine-connector.ts";
export { MachineAccountSections, type MachineAccountAccess } from "./machine-account-settings.tsx";
