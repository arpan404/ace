import Foundation

/// Service → daemon messages, each `{"v":1,"type":…}`:
///
///     {"v":1,"type":"reply","id":"r1","ok":true,"status":{…}}
///     {"v":1,"type":"reply","id":"r4","ok":false,"error":{"code":"not_locked","message":"…"}}
///     {"v":1,"type":"state","status":{…}}                // on every phase or session change
///     {"v":1,"type":"completion","attemptID":"…","threadID":"…","turnID":"…",
///         "reason":"finished","workError":null}          // only after work exited AND the OS confirmed relock
///     {"v":1,"type":"error","code":"unlock_request_failed","message":"…","attemptID":"…"}
///
/// status: {"phase":"ready","session":"locked","userID":501,"sessionID":100003,
///          "attemptID":null,"installation":{"pluginSigned":true,"ruleReachesMechanism":true,
///          "lockOnDisplaySleep":true,"brokerLinked":true,"guardianLinked":true,"verified":true}}
/// phase: disabled | ready | covering | authorizing | unlocking | working | relocking |
///        manualUnlockRequired | faulted.  session: locked | unlocked | unavailable.
/// The daemon may run computer-use tools for the attempt only while phase is "working".
public struct LockedUseStatus: Codable, Equatable, Sendable {
    public struct Installation: Codable, Equatable, Sendable {
        public var pluginSigned, ruleReachesMechanism, lockOnDisplaySleep, brokerLinked, guardianLinked, verified: Bool
        public init(pluginSigned: Bool, ruleReachesMechanism: Bool, lockOnDisplaySleep: Bool, brokerLinked: Bool,
                    guardianLinked: Bool, verified: Bool) {
            self.pluginSigned = pluginSigned
            self.ruleReachesMechanism = ruleReachesMechanism
            self.lockOnDisplaySleep = lockOnDisplaySleep
            self.brokerLinked = brokerLinked
            self.guardianLinked = guardianLinked
            self.verified = verified
        }
    }

    public var phase: String
    public var session: String
    public var userID: UInt32?
    public var sessionID: UInt32?
    public var attemptID: String?
    public var installation: Installation

    public init(phase: String, session: String, userID: UInt32?, sessionID: UInt32?, attemptID: String?, installation: Installation) {
        self.phase = phase
        self.session = session
        self.userID = userID
        self.sessionID = sessionID
        self.attemptID = attemptID
        self.installation = installation
    }
}

public struct LockedUseWireError: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

public enum LockedUseOutbound: Equatable, Sendable {
    case reply(id: String, status: LockedUseStatus?)
    case failure(id: String, LockedUseWireError)
    case state(LockedUseStatus)
    case completion(attemptID: String, threadID: String, turnID: String, reason: String, workError: String?)
    case error(LockedUseWireError, attemptID: String?)

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Wire(self))
    }
}

private struct Wire: Encodable {
    let message: LockedUseOutbound
    init(_ message: LockedUseOutbound) { self.message = message }

    enum Key: String, CodingKey { case v, type, id, ok, status, error, attemptID, threadID, turnID, reason, workError, code, message }

    func encode(to encoder: Encoder) throws {
        var out = encoder.container(keyedBy: Key.self)
        try out.encode(1, forKey: .v)
        switch message {
        case .reply(let id, let status):
            try out.encode("reply", forKey: .type)
            try out.encode(id, forKey: .id)
            try out.encode(true, forKey: .ok)
            try out.encodeIfPresent(status, forKey: .status)
        case .failure(let id, let error):
            try out.encode("reply", forKey: .type)
            try out.encode(id, forKey: .id)
            try out.encode(false, forKey: .ok)
            try out.encode(error, forKey: .error)
        case .state(let status):
            try out.encode("state", forKey: .type)
            try out.encode(status, forKey: .status)
        case .completion(let attempt, let thread, let turn, let reason, let workError):
            try out.encode("completion", forKey: .type)
            try out.encode(attempt, forKey: .attemptID)
            try out.encode(thread, forKey: .threadID)
            try out.encode(turn, forKey: .turnID)
            try out.encode(reason, forKey: .reason)
            if let workError { try out.encode(workError, forKey: .workError) } else { try out.encodeNil(forKey: .workError) }
        case .error(let error, let attempt):
            try out.encode("error", forKey: .type)
            try out.encode(error.code, forKey: .code)
            try out.encode(error.message, forKey: .message)
            try out.encodeIfPresent(attempt, forKey: .attemptID)
        }
    }
}
