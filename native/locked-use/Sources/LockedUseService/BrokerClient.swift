import Foundation
import LockedUseBrokerKit
import LockedUseIPC
import LockedUseRuntime

/// Registers this GUI-session coordinator with the root authority broker and answers its
/// forwarded plug-in queries on the main actor. The coordinator still applies every check.
@MainActor public final class LockedUseBrokerClient {
    public private(set) var linked = false
    private let connect: () -> NSXPCConnection
    private weak var coordinator: LockedUseCoordinator?
    private var connection: NSXPCConnection?
    private var registering = false

    public init(connect: @escaping () -> NSXPCConnection, coordinator: LockedUseCoordinator) {
        self.connect = connect
        self.coordinator = coordinator
    }

    /// Call at startup and again whenever `linked` is false. Returns at once; `linked`
    /// becomes true on the main actor only when the broker accepts this connection.
    public func register(done: @escaping @MainActor (Bool) -> Void = { _ in }) {
        guard !registering else { return done(false) }
        registering = true
        linked = false
        connection?.invalidate()
        let next = connect()
        next.remoteObjectInterface = NSXPCInterface(with: LockedUseBrokerRegistration.self)
        next.exportedInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        next.exportedObject = BrokerAnswer(coordinator: coordinator)
        let dropped: () -> Void = { [weak self, weak next] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let next, self.connection === next else { return }
                    // The broker forgot this registration; the next refresh registers again.
                    self.linked = false
                    self.connection = nil
                    next.invalidate()
                }
            }
        }
        next.invalidationHandler = dropped
        next.interruptionHandler = dropped
        next.resume()
        connection = next
        lockedUseCallAsync(next, timeout: .milliseconds(500), { (proxy: LockedUseBrokerRegistration, reply) in
            proxy.register(reply: reply)
        }, done: { [weak self, weak next] accepted in
            guard let self else { return }
            registering = false
            // A link dropped or replaced while the reply was in flight stays unlinked.
            let current = next != nil && connection === next
            linked = accepted && current
            done(linked)
        })
    }

    public func stop() {
        connection?.invalidate()
        connection = nil
        linked = false
    }
}

private final class BrokerAnswer: NSObject, LockedUseAuthorizing, @unchecked Sendable {
    private weak var coordinator: LockedUseCoordinator?

    init(coordinator: LockedUseCoordinator?) { self.coordinator = coordinator }

    func authorize(attempt: String, transaction: Data, request: String, deadline: UInt64, reply: @escaping (Bool) -> Void) {
        guard let id = UUID(uuidString: request) else { reply(false); return }
        let facts = LockedUsePluginRequest(attempt: attempt, transaction: transaction, requestID: id, deadline: deadline)
        let allowed = DispatchQueue.main.sync {
            MainActor.assumeIsolated { [weak coordinator] in coordinator?.authorize(facts) ?? false }
        }
        reply(allowed)
    }
}
