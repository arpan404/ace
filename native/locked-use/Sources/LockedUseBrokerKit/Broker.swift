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
///
/// Who may be the coordinator (see `LockedUseCoordinatorSlot`): a process carrying the
/// pinned signature, whose parent passes `vetAncestry`, while no other coordinator is
/// linked and no granted attempt may still be live. The first to qualify holds the slot
/// until its link drops; nothing replaces it.
public final class LockedUseAuthorityBroker: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    public typealias Refused = (_ refusal: LockedUseRegistrationRefusal, _ pid: Int32) -> Void

    private let listener: NSXPCListener
    private let requirement: String?
    private let now: () -> UInt64
    private let vetAncestry: (Int32) -> Bool
    private let refused: Refused
    private let state = NSLock()
    private var slot: LockedUseCoordinatorSlot<ObjectIdentifier>
    private var coordinator: NSXPCConnection?

    /// `requirement` pins the coordinator's signature; production passes the team-pinned
    /// screen-helper requirement and only in-process tests pass nil. `vetAncestry` gets the
    /// registering process id and says whether a trusted ace daemon spawned it.
    public init(listener: NSXPCListener, requirement: String?, now: @escaping () -> UInt64,
                attemptWindow: UInt64 = LockedUseCoordinatorSlot<ObjectIdentifier>.defaultAttemptWindow,
                vetAncestry: @escaping (Int32) -> Bool, refused: @escaping Refused = { _, _ in }) {
        self.listener = listener
        self.requirement = requirement
        self.now = now
        self.vetAncestry = vetAncestry
        self.refused = refused
        slot = LockedUseCoordinatorSlot(attemptWindow: attemptWindow)
        super.init()
        listener.delegate = self
    }

    public func start() { listener.resume() }
    public func stop() {
        listener.invalidate()
        state.lock()
        let current = coordinator
        if let current { slot.dropped(ObjectIdentifier(current)) }
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
        let at = now()
        guard decision.allowed, at < request.deadline else { return false }
        state.lock()
        slot.granted(by: ObjectIdentifier(link), now: at)
        state.unlock()
        return true
    }

    fileprivate func register(_ connection: NSXPCConnection) -> Bool {
        let pid = connection.processIdentifier
        // Signature checks can be slow; run them before taking the lock.
        let trusted = vetAncestry(pid)
        state.lock()
        let refusal = slot.register(ObjectIdentifier(connection), trusted: trusted, now: now())
        if refusal == nil { coordinator = connection }
        state.unlock()
        if let refusal { refused(refusal, pid) }
        return refusal == nil
    }

    private func drop(_ connection: NSXPCConnection?) {
        guard let connection else { return }
        state.lock()
        slot.dropped(ObjectIdentifier(connection))
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
        reply(broker.register(connection))
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
