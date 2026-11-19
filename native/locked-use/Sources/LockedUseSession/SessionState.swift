import LockedUseCore
import LockedUseRuntime
import LockedUseSystem

/// Classifies one read of the GUI session for an approved scope. Anything other than a
/// readable console session belonging to the scope's user and audit session is unavailable;
/// unavailable never confirms an unlock or a lock.
public func lockedUseSessionState(_ facts: LockedUseSessionFacts?, for scope: LockedUseScope) -> LockedUseSessionState {
    guard let facts, facts.userID == scope.userID, facts.sessionID == scope.sessionID else { return .unavailable }
    return lockedUseSessionState(facts)
}

/// The same classification without a scope, for manual-unlock tracking between attempts.
public func lockedUseSessionState(_ facts: LockedUseSessionFacts?) -> LockedUseSessionState {
    guard let facts, facts.onConsole == true, facts.loginDone == true, !facts.lockFlagMalformed,
          facts.userID != nil, facts.sessionID != nil else { return .unavailable }
    return facts.screenLocked == true ? .locked : .unlocked
}
