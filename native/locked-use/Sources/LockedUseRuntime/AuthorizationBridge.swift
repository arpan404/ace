import Foundation
import LockedUseIPC

/// Connects the authorization-only XPC endpoint to the same serialized coordinator
/// that owns cancellation and protection. It never enables or begins an attempt.
@MainActor public final class LockedUseAuthorizationBridge {
    private let endpoint: LockedUseAuthorizationEndpoint

    public init(listener: NSXPCListener, coordinator: LockedUseCoordinator, now: @escaping () -> UInt64) {
        endpoint = LockedUseAuthorizationEndpoint(listener: listener, now: now) { [weak coordinator] request in
            // AuthorizationGate invokes its verifier on its dedicated decision queue.
            // The endpoint also checks the continuous deadline after this returns.
            DispatchQueue.main.sync {
                MainActor.assumeIsolated { coordinator?.authorize(request) ?? false }
            }
        }
    }

    public func start() { endpoint.start() }
    public func stop() { endpoint.stop() }
}
