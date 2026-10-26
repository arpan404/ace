import Foundation
import CoreGraphics

/// Raw facts about the GUI session this process runs in. They are classified elsewhere;
/// nothing here decides that the desktop is unlocked.
public struct LockedUseSessionFacts: Equatable, Sendable {
    public let onConsole: Bool?
    public let loginDone: Bool?
    /// Absent while unlocked on current macOS. A present non-boolean value is malformed.
    public let screenLocked: Bool?
    public let lockFlagMalformed: Bool
    public let userID: UInt32?
    /// The audit session id (`kCGSSessionAuditIDKey`), which the daemon uses as the scope's sessionID.
    public let sessionID: UInt32?

    public init(onConsole: Bool?, loginDone: Bool?, screenLocked: Bool?, lockFlagMalformed: Bool = false,
                userID: UInt32?, sessionID: UInt32?) {
        self.onConsole = onConsole
        self.loginDone = loginDone
        self.screenLocked = screenLocked
        self.lockFlagMalformed = lockFlagMalformed
        self.userID = userID
        self.sessionID = sessionID
    }
}

/// Reads the Quartz session dictionary. `CGSSessionScreenIsLocked` and the audit id key are
/// the same best-effort, undocumented keys the screen engine already relies on; a missing
/// dictionary or console/login fact reads as unavailable, never as unlocked.
public func lockedUseReadQuartzSession() -> LockedUseSessionFacts? {
    guard let values = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
    let raw = values["CGSSessionScreenIsLocked"]
    return LockedUseSessionFacts(onConsole: values[kCGSessionOnConsoleKey as String] as? Bool,
        loginDone: values[kCGSessionLoginDoneKey as String] as? Bool,
        screenLocked: raw as? Bool, lockFlagMalformed: raw != nil && raw as? Bool == nil,
        userID: (values[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value,
        sessionID: (values["kCGSSessionAuditIDKey"] as? NSNumber)?.uint32Value)
}
