import CryptoKit
import Foundation

/// Whose kept Spade state a connection may see (`bridge/spade-checkpoint.ts`,
/// `bridge/spade-kept-events.ts`): the principal it signs in as, on that machine. A machine's
/// cache is keyed by host and device, and an account machine's device is this install, the same
/// for every account; so the Spade tab's roster and a conversation's events are kept apart per
/// principal too, and one account's never show for another.
enum KeptScope {
    /// An account session, by its token's hash: every sign-in is its own principal, known before
    /// the machine answers, and the token itself never leaves the Keychain.
    nonisolated static func account(token: String) -> String { "account:" + hex(Data(token.utf8)) }
    /// A principal on one machine (or one organization's host), as the bridge files it.
    nonisolated static func of(principal: String, hostId: String) -> String { hex(Data("\(principal)\u{0}\(hostId)".utf8)) }
    private nonisolated static func hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

extension ConnectionTarget {
    /// Who this connection signs in as: the account session through the relay, else the paired
    /// device. Nil through the relay while signed out: nothing is kept then.
    var principal: String? { relay == nil ? "device:\(deviceId)" : relay?.principal }
    /// Where this connection's kept Spade state is filed; nil keeps none.
    var keptScope: String? { principal.map { KeptScope.of(principal: $0, hostId: scope.hostId) } }
}
