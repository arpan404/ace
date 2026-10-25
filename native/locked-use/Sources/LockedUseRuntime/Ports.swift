import Foundation
import LockedUseCore
import LockedUseIPC

/// Implemented in the GUI process. A panel's visibility alone is insufficient proof:
/// the owner must also verify window ordering and input suppression.
@MainActor public protocol LockedUseDesktop {
    func displays() throws -> LockedUseDisplays
    func prepare(_ scope: LockedUseScope) throws
    func protection() throws -> LockedUseProtection
    func showWorking()
    func showRelocking()
    func removeAfterConfirmedLock()
}

/// The implementation must initiate a real OS transaction, not request an unrelated
/// authorization right. Notifications are returned through the coordinator's OS callbacks.
@MainActor public protocol LockedUseSessionDriver {
    var verifiedInstallation: Bool { get }
    func state(of scope: LockedUseScope) -> LockedUseSessionState
    func requestUnlock(_ scope: LockedUseScope) throws
    func requestRelock(_ scope: LockedUseScope)
    func binds(_ request: LockedUsePluginRequest, to scope: LockedUseScope) -> Bool
}

/// Lives outside the desktop/agent process. It must relock on IPC loss or missed
/// heartbeats without depending on this coordinator to execute another instruction.
@MainActor public protocol LockedUseGuardian {
    func arm(_ scope: LockedUseScope) throws
    func heartbeat(_ scope: LockedUseScope) throws
    func ready(_ scope: LockedUseScope) -> Bool
    func disarmAfterConfirmedLock(_ scope: LockedUseScope)
}

public enum LockedUseSessionState { case locked, unlocked, unavailable }
public enum LockedUseRuntimeError: Error { case driverUnavailable, busy, notLocked }

public struct LockedUseCompletion {
    public let scope: LockedUseScope
    public let reason: LockedUseStopReason
    public let workError: Error?
}
