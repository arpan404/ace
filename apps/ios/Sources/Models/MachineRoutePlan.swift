import Foundation

/// Which route one machine's runtime takes when the phone can reach it two ways (ADR 0115): the
/// paired, pinned direct address (LAN or Tailscale) and the ace account's relay. Direct while it
/// works; the relay once direct can't be reached; back to direct when, after the network changes
/// or the app wakes, a probe of the direct address answers. Pure: the machine list feeds it the
/// runtime's connection states and the probe's answers, and opens what it says.
struct MachineRoutePlan: Equatable, Sendable {
    enum Route: String, Sendable { case direct, relay }
    enum Step: Equatable, Sendable {
        case stay
        /// Reconnect the machine's runtime on this route.
        case open(Route)
        /// Check whether the direct address answers, then report it to `probed(answered:)`.
        case probeDirect
    }
    private(set) var hasDirect: Bool
    private(set) var hasRelay: Bool
    private(set) var current: Route
    /// A probe is out; another isn't started until it answers.
    private(set) var probing = false

    init(direct: Bool, relay: Bool) {
        hasDirect = direct; hasRelay = relay
        current = direct || !relay ? .direct : .relay
    }

    /// The machine's routes changed (the account listed it, or stopped). A route that went away
    /// is left for the one that's still there.
    mutating func routes(direct: Bool, relay: Bool) -> Step {
        hasDirect = direct; hasRelay = relay
        switch current {
        case .direct where !direct && relay: return use(.relay)
        case .relay where !relay && direct: return use(.direct)
        default: return .stay
        }
    }
    /// The runtime on the current route changed state. Only `reconnecting` (it couldn't reach the
    /// machine) moves anything: offline means the phone has no network, and every other state is
    /// the route working or a problem a route change doesn't fix.
    mutating func connection(_ state: String) -> Step {
        guard state == "reconnecting" else { return .stay }
        switch current {
        case .direct where hasRelay: return use(.relay)
        case .relay: return probe()
        default: return .stay
        }
    }
    /// The phone woke, or came online on another network: the direct address may answer again.
    mutating func networkChanged() -> Step { probe() }
    /// What the probe found. Only an answer while still on the relay moves back to direct.
    mutating func probed(answered: Bool) -> Step {
        guard probing else { return .stay }
        probing = false
        guard answered, current == .relay, hasDirect else { return .stay }
        return use(.direct)
    }

    private mutating func use(_ route: Route) -> Step {
        current = route
        probing = false
        return .open(route)
    }
    private mutating func probe() -> Step {
        guard current == .relay, hasDirect, !probing else { return .stay }
        probing = true
        return .probeDirect
    }
}

/// Whether a paired machine's pinned direct address answers: one HTTPS request that only
/// completes when the server presents the pinned key. Any HTTP status counts.
enum DirectProbe {
    static func answers(_ target: ConnectionTarget) async -> Bool {
        guard let origin = target.httpsOrigin, let pin = target.pin else { return false }
        let request = PinnedHTTPRequest(method: "GET", path: "/v1/health", body: nil, token: nil)
        return await withCheckedContinuation { continuation in
            PinnedHTTP.send(origin: origin, pin: pin, request: request, timeout: 5) { result in
                if case .success = result { continuation.resume(returning: true) } else { continuation.resume(returning: false) }
            }
        }
    }
}
