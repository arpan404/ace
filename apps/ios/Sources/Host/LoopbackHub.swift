import Foundation
import Network

/// What one runtime's script hears about the phone's loopback (`aceLoopback`, ADR 0194).
enum LoopbackEvent: Sendable, Equatable {
    case accept(String, port: Int)
    case data(String, Data)
    case written(String)
    case end(String)
    case reset(String)
    /// Another runtime took the listeners.
    case released
}

/// A runtime that may hold the phone's loopback listeners.
protocol LoopbackClient: AnyObject, Sendable {
    /// Called on the hub's queue; the client hands it to its own thread.
    func loopback(_ event: LoopbackEvent)
}

/// What `loopback.listen` answers (`@ace/native-host`'s `LoopbackListening`).
struct LoopbackListening: Codable, Equatable, Sendable {
    var listening: [Int]
    var busy: [Int]
}

/// The phone's own loopback ports, taken for the machine whose device tab is in front
/// (ADR 0194). iOS never sends `localhost` to a proxy, so the app listens on `127.0.0.1` and `::1`
/// itself and hands each connection to that machine's runtime, which opens a tunnel stream.
/// It decides nothing: which ports, and which runtime holds them, come from the shared script.
/// One runtime holds the listeners at a time; asking for ports takes them from another.
/// Connections it accepted stay with it until they end. Every handler runs on `queue`.
final class LoopbackHub: @unchecked Sendable {
    /// The app's one set of listeners: the phone has one loopback.
    static let shared = LoopbackHub()
    /// The most one read hands to the script.
    static let chunk = 64 * 1024
    static let maxPorts = 64
    /// How long a listener may take to come up before its port reads as failed.
    static let bindTimeout: DispatchTimeInterval = .seconds(3)

    private let queue: DispatchQueue
    private weak var holder: (any LoopbackClient)?
    private var listeners: [Int: PortListeners] = [:]
    private var connections: [String: Accepted] = [:]
    private var nextId = 0

    init(queue: DispatchQueue = DispatchQueue(label: "ace.loopback", qos: .userInitiated)) {
        self.queue = queue
    }

    /// Listens on `ports` for `client`, closing any other ports. `answer` runs exactly once,
    /// when every wanted port's listeners are up or have failed, and names as listening only the
    /// ports this client still holds then: another runtime asking meanwhile leaves it none. When
    /// the holder asks for nothing, its connections end too: the page is no longer in front.
    func listen(_ ports: [Int], for client: any LoopbackClient, answer: @escaping @Sendable (LoopbackListening) -> Void) {
        queue.async { [self] in
            let wanted = Set(ports.filter { (1...65535).contains($0) }.prefix(Self.maxPorts))
            if holder !== client {
                // Asking for nothing never takes the listeners from the runtime holding them.
                if wanted.isEmpty { answer(LoopbackListening(listening: [], busy: [])); return }
                let previous = holder
                holder = client
                // Listeners on ports both want stay up and serve the new holder from its next
                // connection on: closing and binding a port again races its close.
                previous?.loopback(.released)
            }
            for port in listeners.keys where !wanted.contains(port) { listeners.removeValue(forKey: port)?.cancel() }
            if wanted.isEmpty {
                holder = nil
                endConnections(of: client)
                answer(LoopbackListening(listening: [], busy: []))
                return
            }
            for port in wanted where listeners[port] == nil {
                let listener = PortListeners(port: port, queue: queue) { [weak self] connection in
                    self?.accepted(connection, port: port)
                }
                listeners[port] = listener
                // A port another app holds goes, whichever request is waiting on it.
                listener.whenSettled { [weak self, weak listener] outcome in
                    guard outcome == .busy, let self, let listener, self.listeners[port] === listener else { return }
                    self.listeners.removeValue(forKey: port)
                    listener.cancel()
                }
                listener.start()
            }
            // Every wanted port, new or kept, counts once its listeners settle: one kept from an
            // earlier request may still be binding.
            let outcomes = PortOutcomes()
            let group = DispatchGroup()
            for port in wanted {
                guard let listener = listeners[port] else { continue }
                group.enter()
                listener.whenSettled { outcome in
                    outcomes.set(port, outcome, listener)
                    group.leave()
                }
            }
            group.notify(queue: queue) { [weak self] in
                guard let self else { answer(LoopbackListening(listening: [], busy: [])); return }
                let held = self.holder === client
                let listening = outcomes.up.filter { held && self.listeners[$0.key] === $0.value }.keys.sorted()
                answer(LoopbackListening(listening: listening, busy: outcomes.busy.sorted()))
            }
        }
    }

    /// The client is going away: its listeners close and its connections end.
    func release(_ client: any LoopbackClient) {
        queue.async { [self] in
            if holder === client || holder == nil { closeListeners(); holder = nil }
            for (id, connection) in connections where connection.client === client || connection.client == nil {
                connections.removeValue(forKey: id)
                connection.connection.forceCancel()
            }
        }
    }

    /// One of `LoopbackAction` on connection `id`, from its client's script.
    func act(_ id: String, action: String, bytes: Data?) {
        queue.async { [self] in
            guard let accepted = connections[id] else { return }
            switch action {
            case "read": read(id, accepted)
            case "write":
                guard let bytes, !bytes.isEmpty, !accepted.sendEnded else { return }
                accepted.connection.send(content: bytes, completion: .contentProcessed { [weak self] error in
                    guard let self, self.connections[id] != nil else { return }
                    if error != nil { self.fail(id) } else { accepted.client?.loopback(.written(id)) }
                })
            case "end": end(id, accepted)
            case "close":
                // The machine's side is gone: close once the end has gone, never with a reset.
                accepted.closing = true
                if !accepted.sendEnded { end(id, accepted) } else if accepted.endSent { close(id) }
            case "reset":
                connections.removeValue(forKey: id)
                accepted.connection.forceCancel()
            default: break
            }
        }
    }

    // MARK: - On `queue`

    private func end(_ id: String, _ accepted: Accepted) {
        guard !accepted.sendEnded else { return }
        accepted.sendEnded = true
        accepted.connection.send(content: nil, contentContext: .finalMessage, isComplete: true,
                                 completion: .contentProcessed { [weak self] error in
            guard let self, self.connections[id] != nil else { return }
            accepted.endSent = true
            if error != nil { self.fail(id) } else if accepted.closing { self.close(id) } else { self.finishIfDone(id) }
        })
    }

    /// Closes a connection quietly (FIN already sent, no reset), whatever the page still does.
    private func close(_ id: String) {
        guard let accepted = connections.removeValue(forKey: id) else { return }
        accepted.connection.cancel()
    }

    /// Ends every connection `client` accepted, open or not yet announced.
    private func endConnections(of client: any LoopbackClient) {
        for (id, connection) in connections where connection.client === client {
            connections.removeValue(forKey: id)
            connection.connection.forceCancel()
            if connection.announced { client.loopback(.reset(id)) }
        }
    }

    private func closeListeners() {
        for listener in listeners.values { listener.cancel() }
        listeners.removeAll()
    }

    private func accepted(_ connection: NWConnection, port: Int) {
        guard let holder else { connection.cancel(); return }
        nextId += 1
        let id = "l\(nextId)"
        let accepted = Accepted(connection: connection, client: holder)
        connections[id] = accepted
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard !accepted.announced else { return }
                accepted.announced = true
                accepted.client?.loopback(.accept(id, port: port))
            case .failed, .cancelled: if self.connections[id] != nil { self.fail(id) }
            default: break
            }
        }
        connection.start(queue: queue)
    }

    private func read(_ id: String, _ accepted: Accepted) {
        guard !accepted.receiveEnded, !accepted.reading else { return }
        accepted.reading = true
        accepted.connection.receive(minimumIncompleteLength: 1, maximumLength: Self.chunk) { [weak self] data, _, complete, error in
            guard let self, self.connections[id] != nil else { return }
            accepted.reading = false
            if let data, !data.isEmpty { accepted.client?.loopback(.data(id, data)) }
            if error != nil { self.fail(id); return }
            if complete {
                accepted.receiveEnded = true
                accepted.client?.loopback(.end(id))
                self.finishIfDone(id)
            }
        }
    }

    /// Both sides sent all they will: the connection closes quietly.
    private func finishIfDone(_ id: String) {
        guard let accepted = connections[id], accepted.sendEnded, accepted.receiveEnded else { return }
        connections.removeValue(forKey: id)
        accepted.connection.cancel()
    }

    private func fail(_ id: String) {
        guard let accepted = connections.removeValue(forKey: id) else { return }
        accepted.connection.forceCancel()
        accepted.client?.loopback(.reset(id))
    }
}

/// How each port of one `listen` settled; touched only on the hub's queue.
private final class PortOutcomes: @unchecked Sendable {
    private(set) var up: [Int: PortListeners] = [:]
    private(set) var busy: [Int] = []
    func set(_ port: Int, _ outcome: PortListeners.Outcome, _ listener: PortListeners) {
        switch outcome {
        case .up: up[port] = listener
        case .busy: busy.append(port)
        case .cancelled: break
        }
    }
}

/// One accepted connection; touched only on the hub's queue.
private final class Accepted: @unchecked Sendable {
    let connection: NWConnection
    weak var client: (any LoopbackClient)?
    var announced = false
    var reading = false
    var receiveEnded = false
    var sendEnded = false
    /// The end (FIN) has been handed to the network.
    var endSent = false
    /// The machine's side is gone: close as soon as the end has gone.
    var closing = false
    init(connection: NWConnection, client: any LoopbackClient) {
        self.connection = connection; self.client = client
    }
}

/// One port on both loopback addresses. It is up once `127.0.0.1` listens and `::1` listens too,
/// or the phone has no IPv6 loopback (`::1` can't be bound at all, rather than being taken).
/// Either address failing because the port is in use is tried again a few times, as a port this
/// app closed a moment ago may still be closing; then the port reads as another app's. It settles
/// exactly once: up, busy, or cancelled (another request no longer wants it). Touched only on
/// `queue`.
final class PortListeners: @unchecked Sendable {
    enum Outcome: Equatable, Sendable { case up, busy, cancelled }
    private enum Family { case v4, v6 }

    private let port: Int
    private let queue: DispatchQueue
    private let accept: @Sendable (NWConnection) -> Void
    private var v4: NWListener?
    private var v6: NWListener?
    private var v4Up = false
    private var v6Up = false
    /// The phone has no IPv6 loopback to listen on.
    private var v6Absent = false
    private(set) var outcome: Outcome?
    private var waiters: [(Outcome) -> Void] = []

    /// A failed bind is tried this many more times, `retryDelay` apart, before the port is busy.
    static let retries = 4
    static let retryDelay: DispatchTimeInterval = .milliseconds(100)

    init(port: Int, queue: DispatchQueue, accept: @escaping @Sendable (NWConnection) -> Void) {
        self.port = port; self.queue = queue; self.accept = accept
    }

    /// `done` runs once, on the queue, when the port has settled (at once if it has).
    func whenSettled(_ done: @escaping (Outcome) -> Void) {
        if let outcome { done(outcome) } else { waiters.append(done) }
    }

    func start() {
        bind(.v4, attempt: 0)
        bind(.v6, attempt: 0)
        queue.asyncAfter(deadline: .now() + LoopbackHub.bindTimeout) { [weak self] in
            // Still binding: whatever holds it isn't letting go.
            guard let self, self.outcome == nil else { return }
            self.cancelListeners()
            self.settle(.busy)
        }
    }

    func cancel() {
        cancelListeners()
        settle(.cancelled)
    }

    private func settle(_ outcome: Outcome) {
        guard self.outcome == nil else { return }
        self.outcome = outcome
        let waiting = waiters
        waiters.removeAll()
        for waiter in waiting { waiter(outcome) }
    }

    private func cancelListeners() {
        v4?.cancel(); v6?.cancel()
        v4 = nil; v6 = nil
    }

    private func check() {
        if v4Up, v6Up || v6Absent { settle(.up) }
    }

    private func bind(_ family: Family, attempt: Int) {
        guard outcome == nil else { return }
        guard let listener = Self.listener(family == .v4 ? .ipv4(.loopback) : .ipv6(.loopback), port: port) else {
            if family == .v6 { v6Absent = true; check() } else { cancelListeners(); settle(.busy) }
            return
        }
        if family == .v4 { v4 = listener } else { v6 = listener }
        listener.newConnectionHandler = accept
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, let listener else { return }
            switch state {
            case .ready:
                guard self.outcome == nil else { return }
                if family == .v4 { self.v4Up = true } else { self.v6Up = true }
                self.check()
            case .failed(let error):
                listener.cancel()
                if family == .v4, self.v4 === listener { self.v4 = nil; self.v4Up = false }
                if family == .v6, self.v6 === listener { self.v6 = nil; self.v6Up = false }
                guard self.outcome == nil else { return }
                if family == .v6, !Self.inUse(error) {
                    // No IPv6 loopback on this phone: the port serves 127.0.0.1 alone.
                    self.v6Absent = true
                    self.check()
                    return
                }
                guard attempt < Self.retries else { self.cancelListeners(); self.settle(.busy); return }
                self.queue.asyncAfter(deadline: .now() + Self.retryDelay) { [weak self] in self?.bind(family, attempt: attempt + 1) }
            default: break
            }
        }
        listener.start(queue: queue)
    }

    private static func inUse(_ error: NWError) -> Bool {
        if case .posix(let code) = error { return code == .EADDRINUSE }
        return false
    }

    private static func listener(_ host: NWEndpoint.Host, port: Int) -> NWListener? {
        guard let value = NWEndpoint.Port(rawValue: UInt16(port)) else { return nil }
        let tcp = NWProtocolTCP.Options()
        // Page requests are small and many: never hold one back to fill a segment.
        tcp.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.requiredLocalEndpoint = .hostPort(host: host, port: value)
        // A connection the phone closed first leaves its port in TIME_WAIT; without reuse the port
        // couldn't be listened on again for half a minute. A port another app listens on still fails.
        parameters.allowLocalEndpointReuse = true
        return try? NWListener(using: parameters)
    }
}
