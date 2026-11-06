import Foundation

/// Which route one machine's runtime takes when the phone can reach it two ways (ADR 0115): the
/// paired, pinned direct address (LAN or Tailscale) and the ace account's relay. Direct while it
/// works; the relay once direct can't be reached; back to direct when, after the network changes
/// or the app wakes, the direct address opens a socket. Pure: the machine list feeds it the
/// runtime's connection states, the probe's answers and the time, and opens what it says.
///
/// Moving back is held off so a working relay isn't thrown away for a direct route that only
/// half works: never sooner than `hold` after taking the relay, and after a move back that
/// failed again before it was ready, not for a cooldown that doubles each time (`cooldown`).
struct MachineRoutePlan: Equatable, Sendable {
    enum Route: String, Sendable { case direct, relay }
    enum Step: Equatable, Sendable {
        case stay
        /// Reconnect the machine's runtime on this route.
        case open(Route)
        /// Check whether the direct address opens a socket, then report it to `probed`.
        case probeDirect
        /// Asked to look again inside the hold or cooldown: look again (`networkChanged`) at this
        /// time (ms), even if nothing else happens by then.
        case reconsider(at: Double)
    }
    /// The least time on the relay before moving back (ms), as ADR 0114's switch hold.
    static let hold: Double = 10_000
    /// The wait after a move back that didn't hold, doubling up to `longestCooldown` (ms).
    static let cooldown: Double = 30_000
    static let longestCooldown: Double = 5 * 60_000

    private(set) var hasDirect: Bool
    private(set) var hasRelay: Bool
    private(set) var current: Route
    /// A probe is out; another isn't started until it answers.
    private(set) var probing = false
    /// The current route's runtime as it last reported, so a route that arrives later is
    /// weighed against how the connection is doing now.
    private(set) var state = "connecting"
    /// No move back to direct before this time (ms).
    private(set) var heldUntil: Double = 0
    /// Back on direct after the relay, and not yet ready there.
    private var trying = false
    private var nextCooldown = Self.cooldown

    init(direct: Bool, relay: Bool) {
        hasDirect = direct; hasRelay = relay
        current = direct || !relay ? .direct : .relay
    }

    /// The machine's routes changed (the account listed it, or stopped). A route that went away
    /// is left for the one that's still there, and a relay that arrives while direct can't
    /// reach the machine is taken at once.
    mutating func routes(direct: Bool, relay: Bool, at now: Double) -> Step {
        hasDirect = direct; hasRelay = relay
        switch current {
        case .direct where relay && (!direct || state == "reconnecting"): return use(.relay, at: now)
        case .relay where !relay && direct: return use(.direct, at: now)
        default: return .stay
        }
    }
    /// The runtime on the current route changed state. Only `reconnecting` (it couldn't reach the
    /// machine) moves anything: offline means the phone has no network, and every other state is
    /// the route working or a problem a route change doesn't fix.
    mutating func connection(_ state: String, at now: Double) -> Step {
        self.state = state
        if current == .direct, state == "ready", trying {
            trying = false
            nextCooldown = Self.cooldown
        }
        guard state == "reconnecting" else { return .stay }
        switch current {
        case .direct where hasRelay:
            if trying {
                // The direct address answered but the connection didn't hold: wait longer next time.
                trying = false
                heldUntil = now + nextCooldown
                nextCooldown = min(nextCooldown * 2, Self.longestCooldown)
            }
            return use(.relay, at: now)
        case .relay: return probe(at: now)
        default: return .stay
        }
    }
    /// The phone woke, or came online on another network: the direct address may answer again.
    /// Inside the hold or cooldown, the plan says when to look again instead.
    mutating func networkChanged(at now: Double) -> Step { probe(at: now) }
    /// What the probe found. Only an answer while still on the relay, past the hold, moves back.
    mutating func probed(answered: Bool, at now: Double) -> Step {
        guard probing else { return .stay }
        probing = false
        guard answered, current == .relay, hasDirect, now >= heldUntil else { return .stay }
        trying = true
        return use(.direct, at: now)
    }

    private mutating func use(_ route: Route, at now: Double) -> Step {
        current = route
        probing = false
        state = "connecting"
        if route == .relay { heldUntil = max(heldUntil, now + Self.hold) }
        return .open(route)
    }
    private mutating func probe(at now: Double) -> Step {
        guard current == .relay, hasDirect, !probing else { return .stay }
        // Dropping the request would leave the machine on the relay until the next event.
        guard now >= heldUntil else { return .reconsider(at: heldUntil) }
        probing = true
        return .probeDirect
    }
}

/// Whether a paired machine's pinned direct address takes a connection: a WebSocket to the
/// daemon's own endpoint that opens only when the server presents the pinned key. An HTTPS
/// answer alone isn't enough, since the relay is only given up for a socket that works.
enum DirectProbe {
    static func answers(_ target: ConnectionTarget) async -> Bool {
        guard target.relay == nil, target.pin != nil else { return false }
        let probe = SocketProbe()
        return await withCheckedContinuation { continuation in
            probe.start(target, timeout: 5, continuation)
        }
    }
}

/// One probe socket, answered once: opened, closed, or out of time.
private final class SocketProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var socket: PinnedSocket?
    func start(_ target: ConnectionTarget, timeout: Double, _ continuation: CheckedContinuation<Bool, Never>) {
        // Held by its own socket and timer until it is answered; `finish` lets both go.
        let socket = PinnedSocket(target: target) { kind, _ in
            if kind == "open" { self.finish(true) } else if kind == "close" { self.finish(false) }
        }
        lock.withLock { self.continuation = continuation; self.socket = socket }
        socket.open()
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { self.finish(false) }
    }
    private func finish(_ opened: Bool) {
        let (waiting, socket) = lock.withLock {
            let taken = (continuation, self.socket)
            continuation = nil; self.socket = nil
            return taken
        }
        socket?.close()
        waiting?.resume(returning: opened)
    }
}
