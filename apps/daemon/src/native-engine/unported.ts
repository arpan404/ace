// SPDX-License-Identifier: Apache-2.0
/**
 * The facade members no item has ported: each throws `NativeEngineIncomplete` naming its item,
 * synchronously or as a rejected promise, and never falls back to the TypeScript engine.
 */
import type { EngineSurface } from "../engine/index.ts";
import { incomplete } from "./contracts.ts";

export class UnportedMembers {
  protected nextPolicy = 1;
  get guests(): EngineSurface["guests"] {
    throw incomplete("guests", "E5.7");
  }
  get hosts(): EngineSurface["hosts"] {
    throw incomplete("hosts", "E5.7");
  }
  get liveMove(): EngineSurface["liveMove"] {
    throw incomplete("liveMove", "E5.9");
  }
  turnOrigin = (
    ..._args: Parameters<EngineSurface["turnOrigin"]>
  ): ReturnType<EngineSurface["turnOrigin"]> => {
    throw incomplete("turnOrigin", "E5.5");
  };
  delegationsInFlight = (
    ..._args: Parameters<EngineSurface["delegationsInFlight"]>
  ): ReturnType<EngineSurface["delegationsInFlight"]> => {
    throw incomplete("delegationsInFlight", "E5.5");
  };
  async retrySettled(
    ..._args: Parameters<EngineSurface["retrySettled"]>
  ): ReturnType<EngineSurface["retrySettled"]> {
    throw incomplete("retrySettled", "E5.10");
  }
  ownershipRefusal(
    ..._args: Parameters<EngineSurface["ownershipRefusal"]>
  ): ReturnType<EngineSurface["ownershipRefusal"]> {
    throw incomplete("ownershipRefusal", "E5.9");
  }
  supportsSteering(
    ..._args: Parameters<EngineSurface["supportsSteering"]>
  ): ReturnType<EngineSurface["supportsSteering"]> {
    throw incomplete("supportsSteering", "E5.5");
  }
  messageFacts(
    ..._args: Parameters<EngineSurface["messageFacts"]>
  ): ReturnType<EngineSurface["messageFacts"]> {
    throw incomplete("messageFacts", "E5.5");
  }
  prioritizeSubagentResult(
    ..._args: Parameters<EngineSurface["prioritizeSubagentResult"]>
  ): ReturnType<EngineSurface["prioritizeSubagentResult"]> {
    throw incomplete("prioritizeSubagentResult", "E5.4");
  }
  spawn(..._args: Parameters<EngineSurface["spawn"]>): ReturnType<EngineSurface["spawn"]> {
    throw incomplete("spawn", "E5.4");
  }
  admitCreation(
    ..._args: Parameters<EngineSurface["admitCreation"]>
  ): ReturnType<EngineSurface["admitCreation"]> {
    throw incomplete("admitCreation", "E5.4");
  }
  creationPending(
    ..._args: Parameters<EngineSurface["creationPending"]>
  ): ReturnType<EngineSurface["creationPending"]> {
    throw incomplete("creationPending", "E5.4");
  }
  access(..._args: Parameters<EngineSurface["access"]>): ReturnType<EngineSurface["access"]> {
    throw incomplete("access", "E5.7");
  }
  targetInstance(
    ..._args: Parameters<EngineSurface["targetInstance"]>
  ): ReturnType<EngineSurface["targetInstance"]> {
    throw incomplete("targetInstance", "E5.7");
  }
  childAccess(
    ..._args: Parameters<EngineSurface["childAccess"]>
  ): ReturnType<EngineSurface["childAccess"]> {
    throw incomplete("childAccess", "E5.7");
  }
  offeredModes(
    ..._args: Parameters<EngineSurface["offeredModes"]>
  ): ReturnType<EngineSurface["offeredModes"]> {
    throw incomplete("offeredModes", "E5.7");
  }
  childPermissionRefusal(
    ..._args: Parameters<EngineSurface["childPermissionRefusal"]>
  ): ReturnType<EngineSurface["childPermissionRefusal"]> {
    throw incomplete("childPermissionRefusal", "E5.7");
  }
  attachChild(
    ..._args: Parameters<EngineSurface["attachChild"]>
  ): ReturnType<EngineSurface["attachChild"]> {
    throw incomplete("attachChild", "E5.10");
  }
  updateChild(
    ..._args: Parameters<EngineSurface["updateChild"]>
  ): ReturnType<EngineSurface["updateChild"]> {
    throw incomplete("updateChild", "E5.10");
  }
  machineChild(
    ..._args: Parameters<EngineSurface["machineChild"]>
  ): ReturnType<EngineSurface["machineChild"]> {
    throw incomplete("machineChild", "E5.10");
  }
  transferHold(
    ..._args: Parameters<EngineSurface["transferHold"]>
  ): ReturnType<EngineSurface["transferHold"]> {
    throw incomplete("transferHold", "E5.10");
  }
  externalHold(
    ..._args: Parameters<EngineSurface["externalHold"]>
  ): ReturnType<EngineSurface["externalHold"]> {
    throw incomplete("externalHold", "E5.10");
  }
  delegationStarted(
    ..._args: Parameters<EngineSurface["delegationStarted"]>
  ): ReturnType<EngineSurface["delegationStarted"]> {
    throw incomplete("delegationStarted", "E5.10");
  }
  delegationSettled(
    ..._args: Parameters<EngineSurface["delegationSettled"]>
  ): ReturnType<EngineSurface["delegationSettled"]> {
    throw incomplete("delegationSettled", "E5.10");
  }
  machineHandoff(
    ..._args: Parameters<EngineSurface["machineHandoff"]>
  ): ReturnType<EngineSurface["machineHandoff"]> {
    throw incomplete("machineHandoff", "E5.9");
  }
  adoptMachineHandoff(
    ..._args: Parameters<EngineSurface["adoptMachineHandoff"]>
  ): ReturnType<EngineSurface["adoptMachineHandoff"]> {
    throw incomplete("adoptMachineHandoff", "E5.9");
  }
  providerProcesses(
    ..._args: Parameters<EngineSurface["providerProcesses"]>
  ): ReturnType<EngineSurface["providerProcesses"]> {
    throw incomplete("providerProcesses", "E5.6");
  }
  backgroundPorts(
    ..._args: Parameters<EngineSurface["backgroundPorts"]>
  ): ReturnType<EngineSurface["backgroundPorts"]> {
    throw incomplete("backgroundPorts", "E5.6");
  }
  activeRun(
    ..._args: Parameters<EngineSurface["activeRun"]>
  ): ReturnType<EngineSurface["activeRun"]> {
    throw incomplete("activeRun", "E5.5");
  }
  aceCaller(
    ..._args: Parameters<EngineSurface["aceCaller"]>
  ): ReturnType<EngineSurface["aceCaller"]> {
    throw incomplete("aceCaller", "E5.5");
  }
  withinAgent(
    ..._args: Parameters<EngineSurface["withinAgent"]>
  ): ReturnType<EngineSurface["withinAgent"]> {
    throw incomplete("withinAgent", "E5.5");
  }
  openHostApproval(
    ..._args: Parameters<EngineSurface["openHostApproval"]>
  ): ReturnType<EngineSurface["openHostApproval"]> {
    throw incomplete("openHostApproval", "E5.7");
  }
  hostError(
    ..._args: Parameters<EngineSurface["hostError"]>
  ): ReturnType<EngineSurface["hostError"]> {
    throw incomplete("hostError", "E5.7");
  }
  hostNotice(
    ..._args: Parameters<EngineSurface["hostNotice"]>
  ): ReturnType<EngineSurface["hostNotice"]> {
    throw incomplete("hostNotice", "E5.7");
  }
  resolveHostApproval(
    ..._args: Parameters<EngineSurface["resolveHostApproval"]>
  ): ReturnType<EngineSurface["resolveHostApproval"]> {
    throw incomplete("resolveHostApproval", "E5.7");
  }
  closeHostGate(
    ..._args: Parameters<EngineSurface["closeHostGate"]>
  ): ReturnType<EngineSurface["closeHostGate"]> {
    throw incomplete("closeHostGate", "E5.7");
  }
  discardRecovery(
    ..._args: Parameters<EngineSurface["discardRecovery"]>
  ): ReturnType<EngineSurface["discardRecovery"]> {
    throw incomplete("discardRecovery", "E5.8");
  }
  cancelRecovery(
    ..._args: Parameters<EngineSurface["cancelRecovery"]>
  ): ReturnType<EngineSurface["cancelRecovery"]> {
    throw incomplete("cancelRecovery", "E5.8");
  }
  captureContinuation(
    ..._args: Parameters<EngineSurface["captureContinuation"]>
  ): ReturnType<EngineSurface["captureContinuation"]> {
    throw incomplete("captureContinuation", "E5.8");
  }
  cancelDelegatedInputs(
    ..._args: Parameters<EngineSurface["cancelDelegatedInputs"]>
  ): ReturnType<EngineSurface["cancelDelegatedInputs"]> {
    throw incomplete("cancelDelegatedInputs", "E5.4");
  }
  async changeWorkspace(
    ..._args: Parameters<EngineSurface["changeWorkspace"]>
  ): ReturnType<EngineSurface["changeWorkspace"]> {
    throw incomplete("changeWorkspace", "E5.9");
  }
  async reconcileThread(
    ..._args: Parameters<EngineSurface["reconcileThread"]>
  ): ReturnType<EngineSurface["reconcileThread"]> {
    throw incomplete("reconcileThread", "E5.10");
  }
  async reconcileOwn(
    ..._args: Parameters<EngineSurface["reconcileOwn"]>
  ): ReturnType<EngineSurface["reconcileOwn"]> {
    throw incomplete("reconcileOwn", "E5.10");
  }
  hasSession(
    ..._args: Parameters<EngineSurface["hasSession"]>
  ): ReturnType<EngineSurface["hasSession"]> {
    throw incomplete("hasSession", "E5.6");
  }
  hasState(..._args: Parameters<EngineSurface["hasState"]>): ReturnType<EngineSurface["hasState"]> {
    throw incomplete("hasState", "E5.3");
  }
  cleanupThreads(
    ..._args: Parameters<EngineSurface["cleanupThreads"]>
  ): ReturnType<EngineSurface["cleanupThreads"]> {
    throw incomplete("cleanupThreads", "E5.10");
  }
  liveWork(..._args: Parameters<EngineSurface["liveWork"]>): ReturnType<EngineSurface["liveWork"]> {
    throw incomplete("liveWork", "E5.10");
  }
  runsProviderWork(
    ..._args: Parameters<EngineSurface["runsProviderWork"]>
  ): ReturnType<EngineSurface["runsProviderWork"]> {
    throw incomplete("runsProviderWork", "E5.10");
  }
  hasUnfinishedWork(
    ..._args: Parameters<EngineSurface["hasUnfinishedWork"]>
  ): ReturnType<EngineSurface["hasUnfinishedWork"]> {
    throw incomplete("hasUnfinishedWork", "E5.10");
  }
  async stopForDeletion(
    ..._args: Parameters<EngineSurface["stopForDeletion"]>
  ): ReturnType<EngineSurface["stopForDeletion"]> {
    throw incomplete("stopForDeletion", "E5.10");
  }
  async cleanupSession(
    ..._args: Parameters<EngineSurface["cleanupSession"]>
  ): ReturnType<EngineSurface["cleanupSession"]> {
    throw incomplete("cleanupSession", "E5.10");
  }
  async stopForCancellation(
    ..._args: Parameters<EngineSurface["stopForCancellation"]>
  ): ReturnType<EngineSurface["stopForCancellation"]> {
    throw incomplete("stopForCancellation", "E5.10");
  }
  forgetPurged(
    ..._args: Parameters<EngineSurface["forgetPurged"]>
  ): ReturnType<EngineSurface["forgetPurged"]> {
    throw incomplete("forgetPurged", "E5.10");
  }
  prepareDeletion(
    ..._args: Parameters<EngineSurface["prepareDeletion"]>
  ): ReturnType<EngineSurface["prepareDeletion"]> {
    throw incomplete("prepareDeletion", "E5.10");
  }
  setSilenceMs(
    ..._args: Parameters<EngineSurface["setSilenceMs"]>
  ): ReturnType<EngineSurface["setSilenceMs"]> {
    throw incomplete("setSilenceMs", "E5.6");
  }
  clearWorkspaceSilenceMs(
    ..._args: Parameters<EngineSurface["clearWorkspaceSilenceMs"]>
  ): ReturnType<EngineSurface["clearWorkspaceSilenceMs"]> {
    throw incomplete("clearWorkspaceSilenceMs", "E5.6");
  }
  async continueImported(
    ..._args: Parameters<EngineSurface["continueImported"]>
  ): ReturnType<EngineSurface["continueImported"]> {
    throw incomplete("continueImported", "E5.8");
  }
  sessionMetadata(
    ..._args: Parameters<EngineSurface["sessionMetadata"]>
  ): ReturnType<EngineSurface["sessionMetadata"]> {
    throw incomplete("sessionMetadata", "E5.6");
  }
  commandFailure(
    ..._args: Parameters<EngineSurface["commandFailure"]>
  ): ReturnType<EngineSurface["commandFailure"]> {
    throw incomplete("commandFailure", "E5.4");
  }
  commandExecution(
    ..._args: Parameters<EngineSurface["commandExecution"]>
  ): ReturnType<EngineSurface["commandExecution"]> {
    throw incomplete("commandExecution", "E5.4");
  }
  queuePage(
    ..._args: Parameters<EngineSurface["queuePage"]>
  ): ReturnType<EngineSurface["queuePage"]> {
    throw incomplete("queuePage", "E5.4");
  }
  queue(..._args: Parameters<EngineSurface["queue"]>): ReturnType<EngineSurface["queue"]> {
    throw incomplete("queue", "E5.4");
  }
  inputFate(
    ..._args: Parameters<EngineSurface["inputFate"]>
  ): ReturnType<EngineSurface["inputFate"]> {
    throw incomplete("inputFate", "E5.4");
  }
  retainsAttachment(
    ..._args: Parameters<EngineSurface["retainsAttachment"]>
  ): ReturnType<EngineSurface["retainsAttachment"]> {
    throw incomplete("retainsAttachment", "E5.3");
  }
  readRawBlob(
    ..._args: Parameters<EngineSurface["readRawBlob"]>
  ): ReturnType<EngineSurface["readRawBlob"]> {
    throw incomplete("readRawBlob", "E5.3");
  }
  async prepareCommand(
    ..._args: Parameters<EngineSurface["prepareCommand"]>
  ): ReturnType<EngineSurface["prepareCommand"]> {
    throw incomplete("prepareCommand", "E5.4");
  }
  admissionReopened(
    ..._args: Parameters<EngineSurface["admissionReopened"]>
  ): ReturnType<EngineSurface["admissionReopened"]> {
    throw incomplete("admissionReopened", "E5.4");
  }
  accountRecovered(
    ..._args: Parameters<EngineSurface["accountRecovered"]>
  ): ReturnType<EngineSurface["accountRecovered"]> {
    throw incomplete("accountRecovered", "E5.8");
  }
  resuming(..._args: Parameters<EngineSurface["resuming"]>): ReturnType<EngineSurface["resuming"]> {
    throw incomplete("resuming", "E5.8");
  }
  endedOnLimit(
    ..._args: Parameters<EngineSurface["endedOnLimit"]>
  ): ReturnType<EngineSurface["endedOnLimit"]> {
    throw incomplete("endedOnLimit", "E5.8");
  }
  treeActive(
    ..._args: Parameters<EngineSurface["treeActive"]>
  ): ReturnType<EngineSurface["treeActive"]> {
    throw incomplete("treeActive", "E5.8");
  }
  limitContinues(
    ..._args: Parameters<EngineSurface["limitContinues"]>
  ): ReturnType<EngineSurface["limitContinues"]> {
    throw incomplete("limitContinues", "E5.8");
  }
  heldInterrupted(
    ..._args: Parameters<EngineSurface["heldInterrupted"]>
  ): ReturnType<EngineSurface["heldInterrupted"]> {
    throw incomplete("heldInterrupted", "E5.8");
  }
  limitsMatter(
    ..._args: Parameters<EngineSurface["limitsMatter"]>
  ): ReturnType<EngineSurface["limitsMatter"]> {
    throw incomplete("limitsMatter", "E5.8");
  }
}
