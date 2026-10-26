import Foundation
import LockedUseIPC

/// Exported by the broker on `dev.ace.locked-use.broker`. The GUI-session service calls
/// `register` and exports `LockedUseAuthorizing` on the same connection for the broker
/// to query. There is no operation that grants, arms or unlocks anything.
@objc(ACELockedUseBrokerRegistration) public protocol LockedUseBrokerRegistration {
    @objc(registerWithReply:) func register(reply: @escaping (Bool) -> Void)
}

/// Runs as root beside the privileged `dev.ace.locked-use.authorization` Mach service. It
/// forwards each authenticated plug-in query to the single registered coordinator and
/// denies whenever no coordinator is linked, the link fails or the deadline passes.
public final class LockedUseAuthorityBroker: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let listener: NSXPCListener
    private let requirement: String?
    private let now: () -> UInt64
    private let state = NSLock()
    private var coordinator: NSXPCConnection?

    /// `requirement` pins the coordinator's signature; production passes the team-pinned
    /// screen-helper requirement and only in-process tests pass nil.
    public init(listener: NSXPCListener, requirement: String?, now: @escaping () -> UInt64) {
        self.listener = listener
        self.requirement = requirement
        self.now = now
        super.init()
        listener.delegate = self
    }

    public func start() { listener.resume() }
    public func stop() {
        listener.invalidate()
        state.lock()
        let current = coordinator
        coordinator = nil
        state.unlock()
        current?.invalidate()
    }

    public var linked: Bool {
        state.lock()
        defer { state.unlock() }
        return coordinator != nil
    }

    public func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        if let requirement { connection.setCodeSigningRequirement(requirement) }
        connection.exportedInterface = NSXPCInterface(with: LockedUseBrokerRegistration.self)
        connection.exportedObject = Registration(broker: self, connection: connection)
        connection.remoteObjectInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        let dropped: () -> Void = { [weak self, weak connection] in self?.drop(connection) }
        connection.invalidationHandler = dropped
        connection.interruptionHandler = dropped
        connection.resume()
        return true
    }

    /// The endpoint's verifier. Blocks its decision queue at most until the request deadline.
    public func forward(_ request: LockedUsePluginRequest) -> Bool {
        state.lock()
        let link = coordinator
        state.unlock()
        let start = now()
        guard let link, request.deadline > start else { return false }
        let decision = Decision()
        let proxy = link.remoteObjectProxyWithErrorHandler { _ in decision.finish(false) }
        guard let coordinator = proxy as? LockedUseAuthorizing else { return false }
        coordinator.authorize(attempt: request.attempt, transaction: request.transaction,
            request: request.requestID.uuidString, deadline: request.deadline) { decision.finish($0) }
        guard decision.wait(nanoseconds: request.deadline - start) else { return false }
        return decision.allowed && now() < request.deadline
    }

    fileprivate func register(_ connection: NSXPCConnection) {
        state.lock()
        let previous = coordinator
        coordinator = connection
        state.unlock()
        // Newest registration wins; the old link can no longer answer, so its attempt expires.
        if previous !== connection { previous?.invalidate() }
    }

    private func drop(_ connection: NSXPCConnection?) {
        state.lock()
        if coordinator === connection { coordinator = nil }
        state.unlock()
    }
}

private final class Registration: NSObject, LockedUseBrokerRegistration {
    private weak var broker: LockedUseAuthorityBroker?
    private weak var connection: NSXPCConnection?

    init(broker: LockedUseAuthorityBroker, connection: NSXPCConnection) {
        self.broker = broker
        self.connection = connection
    }

    func register(reply: @escaping (Bool) -> Void) {
        guard let broker, let connection else { reply(false); return }
        broker.register(connection)
        reply(true)
    }
}

/// One-shot decision: the first of reply, link error or timeout wins.
private final class Decision: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var value: Bool?

    var allowed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value ?? false
    }

    func finish(_ allowed: Bool) {
        lock.lock()
        let first = value == nil
        if first { value = allowed }
        lock.unlock()
        if first { done.signal() }
    }

    func wait(nanoseconds: UInt64) -> Bool {
        done.wait(timeout: .now() + .nanoseconds(Int(min(nanoseconds, 750_000_000)))) == .success
    }
}
