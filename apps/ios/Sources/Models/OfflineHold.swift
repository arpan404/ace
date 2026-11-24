import Foundation

/// When the machines' runtimes hear that the phone lost its network. A path that drops for a
/// moment (the hand-over between Wi-Fi and cellular, walking past a weak access point) would
/// otherwise close every socket at once, even one that would have lived through the blip. So
/// the runtimes hear "offline" only once the path has stayed down for `hold`, and "online"
/// at once. While held, a socket that really died still closes and retries by itself; one
/// that is still healthy keeps going. Pure: times are ms.
struct OfflineHold: Equatable, Sendable {
    /// How long the path must stay down before the runtimes are told (ms).
    static let hold: Double = 4_000
    enum Step: Equatable, Sendable {
        case none
        /// Tell every runtime the phone is online (or not).
        case tell(online: Bool)
        /// Look again (`elapsed`) at this time (ms).
        case check(at: Double)
    }
    /// What the runtimes were last told.
    private(set) var told = true
    /// When the path went down, while that isn't told yet.
    private var downSince: Double?

    /// The OS reported the path.
    mutating func path(online: Bool, at now: Double) -> Step {
        if online {
            downSince = nil
            guard !told else { return .none }
            told = true
            return .tell(online: true)
        }
        guard told else { return .none }
        let since = downSince ?? now
        downSince = since
        return settle(since, at: now)
    }

    /// Time passed while the path was down.
    mutating func elapsed(at now: Double) -> Step {
        guard told, let since = downSince else { return .none }
        return settle(since, at: now)
    }

    private mutating func settle(_ since: Double, at now: Double) -> Step {
        guard now >= since + Self.hold else { return .check(at: since + Self.hold) }
        downSince = nil
        told = false
        return .tell(online: false)
    }
}
