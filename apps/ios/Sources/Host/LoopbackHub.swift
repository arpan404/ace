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

    /// Listens on `ports` for `client`, closing any other ports. `answer` runs once every new
    /// listener is up or failed.
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
            if wanted.isEmpty { holder = nil }
            let fresh = wanted.subtracting(listeners.keys).sorted()
            let busy = PortList()
            let group = DispatchGroup()
            for port in fresh {
                let listener = PortListeners(port: port, queue: queue) { [weak self] connection in
                    self?.accepted(connection, port: port)
                }
                listeners[port] = listener
                group.enter()
                listener.start { [weak self] up in
                    if !up {
                        busy.ports.append(port)
                        self?.listeners.removeValue(forKey: port)?.cancel()
                    }
                    group.leave()
                }
            }
            group.notify(queue: queue) { [weak self] in
                let listening = self?.listeners.keys.sorted() ?? []
                answer(LoopbackListening(listening: listening, busy: busy.ports.sorted()))
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
            case "end":
                guard !accepted.sendEnded else { return }
                accepted.sendEnded = true
                accepted.connection.send(content: nil, contentContext: .finalMessage, isComplete: true,
                                         completion: .contentProcessed { [weak self] error in
                    guard let self, self.connections[id] != nil else { return }
                    if error != nil { self.fail(id) } else { self.finishIfDone(id) }
                })
            case "reset":
                connections.removeValue(forKey: id)
                accepted.connection.forceCancel()
            default: break
            }
        }
    }

    // MARK: - On `queue`

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

/// Ports that failed to bind in one `listen`; touched only on the hub's queue.
private final class PortList: @unchecked Sendable { var ports: [Int] = [] }

/// One accepted connection; touched only on the hub's queue.
private final class Accepted: @unchecked Sendable {
    let connection: NWConnection
    weak var client: (any LoopbackClient)?
    var announced = false
    var reading = false
    var receiveEnded = false
    var sendEnded = false
    init(connection: NWConnection, client: any LoopbackClient) {
        self.connection = connection; self.client = client
    }
}

/// One port on both loopback addresses. The port is up when `127.0.0.1` is; `::1` joins when it
/// can (a phone with IPv6 off has none).
private final class PortListeners: @unchecked Sendable {
    private let port: Int
    private let queue: DispatchQueue
    private let accept: @Sendable (NWConnection) -> Void
    private var v4: NWListener?
    private var v6: NWListener?
    private var settled = false
    init(port: Int, queue: DispatchQueue, accept: @escaping @Sendable (NWConnection) -> Void) {
        self.port = port; self.queue = queue; self.accept = accept
    }

    /// `done(up)` runs once, on the queue, when `127.0.0.1` is listening or has failed.
    func start(_ done: @escaping @Sendable (Bool) -> Void) {
        let finish: @Sendable (Bool) -> Void = { [weak self] up in
            guard let self, !self.settled else { return }
            self.settled = true
            done(up)
        }
        bindV4(finish, attempt: 0)
        if let v6 = Self.listener(.ipv6(.loopback), port: port) {
            self.v6 = v6
            v6.newConnectionHandler = accept
            v6.stateUpdateHandler = { [weak self] state in
                if case .failed = state { self?.v6?.cancel(); self?.v6 = nil }
            }
            v6.start(queue: queue)
        }
        queue.asyncAfter(deadline: .now() + LoopbackHub.bindTimeout) { finish(false) }
    }

    /// A port this app closed a moment ago may still be closing: a failed bind is tried again a
    /// few times before the port reads as another app's.
    private static let retries = 4
    private func bindV4(_ finish: @escaping @Sendable (Bool) -> Void, attempt: Int) {
        guard !settled, let v4 = Self.listener(.ipv4(.loopback), port: port) else { finish(false); return }
        self.v4 = v4
        v4.newConnectionHandler = accept
        v4.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: finish(true)
            case .failed:
                v4.cancel()
                guard let self, attempt < Self.retries else { finish(false); return }
                self.queue.asyncAfter(deadline: .now() + .milliseconds(100)) { [weak self] in self?.bindV4(finish, attempt: attempt + 1) }
            default: break
            }
        }
        v4.start(queue: queue)
    }

    func cancel() {
        settled = true
        v4?.cancel(); v6?.cancel()
        v4 = nil; v6 = nil
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
