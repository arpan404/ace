import Foundation

/// What a relay connection offers for its first handshake message (ADR 0155 steps 1 and 3).
enum RelayShortcut: Sendable, Equatable {
    /// The message rides in the upgrade request (`ace.v2`, `ace.x1.<message>`), or goes as an
    /// early frame (`ace.early.1`) where the relay knows only that.
    case inUpgrade
    /// Only the early frame: after an upgrade carrying the message failed before it opened.
    case early
    /// Neither: after the hosted relay lost a held frame (4020). The message waits for the marker.
    case none
}

/// The relay's connect shortcuts as `docs/relay/README.md` defines them, and the same reading
/// of each answer as the shared client's (`packages/client/src/relay-early.ts`). Pure.
///
/// A WebSocket client fails an upgrade whose answer names no subprotocol it offered, and an
/// older relay echoes only the grant. Every offer here carries the grant first, so whatever a
/// relay knows, it has an entry to echo. The phone always connects with a grant, so it never
/// needs the neutral `ace.relay.1` or `early=1` in its address.
enum RelayEarly {
    static let subprotocol = "ace.early.1"
    static let inUpgrade = "ace.v2"
    static let messagePrefix = "ace.x1."
    /// ace cloud lost the held frame to hibernation: connect again at once without sending early.
    static let lostClose = 4020

    /// When the first handshake message goes, by what the relay echoed.
    enum First: Sendable, Equatable {
        /// The relay took it from the upgrade request: it is never sent as a frame.
        case taken
        /// The relay holds one early frame: send it as the socket opens.
        case now
        /// As before step 1: after the readiness marker.
        case afterMarker
    }

    /// The subprotocols to offer. `first` is the Noise XX first message the handshake state
    /// wrote (its ephemeral public key), so a relay that alters the entry only fails the handshake.
    static func protocols(grant: String, first: Data, offer: RelayShortcut) -> [String] {
        let grant = RelayRoute.grantPrefix + grant
        switch offer {
        case .inUpgrade: return [grant, inUpgrade, messagePrefix + base64url(first), subprotocol]
        case .early: return [grant, subprotocol]
        case .none: return [grant]
        }
    }

    /// An echo counts only for what was offered.
    static func first(echoed: String?, offer: RelayShortcut) -> First {
        if echoed == inUpgrade, offer == .inUpgrade { return .taken }
        if echoed == subprotocol, offer != .none { return .now }
        return .afterMarker
    }

    /// The offer for one more dial after this one failed, or nil for none. Each retry offers
    /// strictly less, so a connection dials at most three times.
    static func retry(after offer: RelayShortcut, upgraded: Bool, closeCode: Int?) -> RelayShortcut? {
        if !upgraded, offer == .inUpgrade { return .early }
        if closeCode == lostClose, offer != .none { return RelayShortcut.none }
        return nil
    }

    /// The one-byte readiness marker: `1`, or `2` from a relay that says it holds early frames.
    static func isMarker(_ bytes: Data) -> Bool { bytes == Data([1]) || bytes == Data([2]) }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
