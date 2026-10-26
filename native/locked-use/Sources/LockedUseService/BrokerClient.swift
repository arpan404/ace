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

    public init(connect: @escaping () -> NSXPCConnection, coordinator: LockedUseCoordinator) {
        self.connect = connect
        self.coordinator = coordinator
    }

    /// Call at startup and again whenever `linked` is false.
    @discardableResult public func register() -> Bool {
        connection?.invalidate()
        let next = connect()
        next.remoteObjectInterface = NSXPCInterface(with: LockedUseBrokerRegistration.self)
        next.exportedInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        next.exportedObject = BrokerAnswer(coordinator: coordinator)
        let dropped: () -> Void = { [weak self, weak next] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.connection === next else { return }
                    self.linked = false
                }
            }
        }
        next.invalidationHandler = dropped
        next.interruptionHandler = dropped
        next.resume()
        connection = next
        linked = lockedUseCall(next, timeout: .milliseconds(500)) { (proxy: LockedUseBrokerRegistration, reply) in
            proxy.register(reply: reply)
        }
        return linked
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
