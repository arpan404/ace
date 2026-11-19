import Foundation
import LockedUseCore

/// Daemon → service requests, served only after the connection's hello (see Handshake.swift).
/// Every request carries `"v": 1` (absent is read as 1), an `id` of 1...64 characters echoed
/// in the reply, and a `type`. Unknown fields are ignored.
///
///     {"v":1,"id":"r1","type":"status"}
///     {"v":1,"id":"r2","type":"enable","optIn":true}   // the person's setting is on
///     {"v":1,"id":"r3","type":"disable"}
///     {"v":1,"id":"r4","type":"begin","optIn":true,"scope":{"userID":501,"sessionID":100003,
///         "threadID":"…","turnID":"…","attemptID":"<unguessable, single-use>"},"agentProcessIDs":[4242]}
///
/// `optIn` is the daemon's assertion that the person's `computer.lockedUse` setting is on.
/// Only the JSON literal `true` counts; absent, false or any other value means off.
///     {"v":1,"id":"r5","type":"finish","attemptID":"…"}   // approved work is done; relock
///     {"v":1,"id":"r6","type":"cancel","attemptID":"…"}
public enum LockedUseCommand: Equatable, Sendable {
    case status(id: String)
    case enable(id: String, optIn: Bool)
    case disable(id: String)
    case begin(id: String, scope: LockedUseScope, agentProcessIDs: Set<Int32>, optIn: Bool)
    case finish(id: String, attemptID: String)
    case cancel(id: String, attemptID: String)

    public var id: String {
        switch self {
        case .status(let id), .enable(let id, _), .disable(let id), .begin(let id, _, _, _),
             .finish(let id, _), .cancel(let id, _): return id
        }
    }
}

public enum LockedUseInbound: Equatable, Sendable {
    case command(LockedUseCommand)
    /// A well-formed request of a type or version this service does not know. Not fatal.
    case unsupported(id: String, type: String)
    /// Unusable JSON or fields. `id` is echoed when it could be read.
    case malformed(id: String?, reason: String)
}

public func lockedUseDecodeInbound(_ frame: Data) -> LockedUseInbound {
    guard let object = try? JSONSerialization.jsonObject(with: frame), let message = object as? [String: Any] else {
        return .malformed(id: nil, reason: "expected a JSON object")
    }
    guard let id = message["id"] as? String, (1...64).contains(id.count),
          id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
        return .malformed(id: nil, reason: "missing or invalid id")
    }
    guard let type = message["type"] as? String, (1...32).contains(type.count) else { return .malformed(id: id, reason: "missing type") }
    if let version = message["v"], lockedUseInteger(version) != 1 { return .unsupported(id: id, type: type) }
    switch type {
    case "status": return .command(.status(id: id))
    case "enable": return .command(.enable(id: id, optIn: lockedUseIsTrue(message["optIn"])))
    case "disable": return .command(.disable(id: id))
    case "finish", "cancel":
        guard let attempt = message["attemptID"] as? String, (1...256).contains(attempt.utf8.count) else {
            return .malformed(id: id, reason: "missing attemptID")
        }
        return .command(type == "finish" ? .finish(id: id, attemptID: attempt) : .cancel(id: id, attemptID: attempt))
    case "begin":
        guard let raw = message["scope"] as? [String: Any], JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let scope = try? JSONDecoder().decode(LockedUseScope.self, from: data) else {
            return .malformed(id: id, reason: "invalid scope")
        }
        let pids = message["agentProcessIDs"] ?? [Any]()
        guard let list = pids as? [Any], list.count <= 64 else { return .malformed(id: id, reason: "invalid agentProcessIDs") }
        var agents = Set<Int32>()
        for value in list {
            guard let number = lockedUseInteger(value), let pid = Int32(exactly: number), pid > 0 else {
                return .malformed(id: id, reason: "invalid agentProcessIDs")
            }
            agents.insert(pid)
        }
        return .command(.begin(id: id, scope: scope, agentProcessIDs: agents, optIn: lockedUseIsTrue(message["optIn"])))
    default:
        return .unsupported(id: id, type: type)
    }
}

/// Only the JSON literal `true`; numbers such as 1 bridge to NSNumber too and are refused.
private func lockedUseIsTrue(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
    return number.boolValue
}

/// JSON integers only: booleans and fractional numbers bridge to NSNumber too and are rejected.
private func lockedUseInteger(_ value: Any) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return Int(exactly: number.doubleValue).flatMap { number.int64Value == Int64($0) ? $0 : nil }
}
