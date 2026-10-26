import Foundation

/// Names the approved work, never a credential or a general authorization right.
public struct LockedUseScope: Codable, Equatable, Sendable {
    public let userID: UInt32
    public let sessionID: UInt32
    public let threadID: String
    public let turnID: String
    public let attemptID: String

    public init(userID: UInt32, sessionID: UInt32, threadID: String, turnID: String, attemptID: String) throws {
        guard userID > 0, sessionID > 0,
              [threadID, turnID, attemptID].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 && !$0.contains("\0") }) else {
            throw LockedUseError.invalidScope
        }
        self.userID = userID
        self.sessionID = sessionID
        self.threadID = threadID
        self.turnID = turnID
        self.attemptID = attemptID
    }

    private enum CodingKeys: String, CodingKey { case userID, sessionID, threadID, turnID, attemptID }

    public init(from decoder: Decoder) throws {
        let data = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(userID: data.decode(UInt32.self, forKey: .userID), sessionID: data.decode(UInt32.self, forKey: .sessionID),
            threadID: data.decode(String.self, forKey: .threadID), turnID: data.decode(String.self, forKey: .turnID),
            attemptID: data.decode(String.self, forKey: .attemptID))
    }
}

public enum LockedUseError: Error, Equatable {
    case invalidScope, notReady, takeoverPending, staleAttempt, invalidProtection, clockWentBackwards
}

/// An exact display topology acknowledged by the protection owner. A count is insufficient:
/// disconnecting one display and adding another must invalidate an old acknowledgement.
public struct LockedUseDisplays: Equatable, Sendable {
    public let ids: Set<UInt32>
    public let generation: UInt64

    public init(ids: Set<UInt32>, generation: UInt64) throws {
        guard !ids.isEmpty, !ids.contains(0), ids.count <= 32 else { throw LockedUseError.invalidProtection }
        self.ids = ids
        self.generation = generation
    }
}

/// These facts must come from authenticated I/O owners, never from a tool argument.
public struct LockedUseProtection: Equatable, Sendable {
    public let displays: LockedUseDisplays
    public let inputGuardReady: Bool
    public let relockGuardReady: Bool

    public init(displays: LockedUseDisplays, inputGuardReady: Bool, relockGuardReady: Bool) {
        self.displays = displays
        self.inputGuardReady = inputGuardReady
        self.relockGuardReady = relockGuardReady
    }

    var ready: Bool { inputGuardReady && relockGuardReady }
}

public enum LockedUseStopReason: String, Sendable {
    case finished, cancelled, workFailed, localInput, protectionLost, connectionLost, expired, clockChanged, sessionChanged, disabled
}

public enum LockedUsePhase: Equatable, Sendable {
    case disabled, ready, covering, authorizing, unlocking, working, relocking, manualUnlockRequired, faulted
}

public enum LockedUseEffect: Equatable, Sendable {
    case coverDisplays(LockedUseScope)
    case requestUnlock(LockedUseScope)
    case runApprovedWork(LockedUseScope)
    case stopWork(LockedUseScope, LockedUseStopReason)
    case relock(LockedUseScope)
    case removeCovers(LockedUseScope)
}
