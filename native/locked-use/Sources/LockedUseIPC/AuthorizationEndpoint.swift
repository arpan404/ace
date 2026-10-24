import Foundation
import Darwin

/// Matches the separately built authorization plug-in's Objective-C protocol exactly.
@objc(ACELockedUseAuthorizing) public protocol LockedUseAuthorizing {
    @objc(authorizeAttempt:transaction:request:deadline:reply:)
    func authorize(attempt: String, transaction: Data, request: String, deadline: UInt64, reply: @escaping (Bool) -> Void)
}

public struct LockedUsePluginRequest: Equatable, Sendable {
    public let attempt: String
    /// Opaque engine transaction bytes. This is deliberately not named a GUI session id.
    public let transaction: Data
    public let requestID: UUID
    public let deadline: UInt64

    public init(attempt: String, transaction: Data, requestID: UUID, deadline: UInt64) {
        self.attempt = attempt
        self.transaction = transaction
        self.requestID = requestID
        self.deadline = deadline
    }
}

/// The installation owner supplies a verifier bound to a live OS transaction and the
/// authority's approved scope. There is no arm, enable, install or unlock RPC here.
public final class LockedUseAuthorizationEndpoint: NSObject, NSXPCListenerDelegate {
    private let listener: NSXPCListener
    private let gate: AuthorizationGate

    public init(listener: NSXPCListener, now: @escaping () -> UInt64 = { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) },
                verify: @escaping (LockedUsePluginRequest) -> Bool) {
        self.listener = listener
        gate = AuthorizationGate(now: now, verify: verify)
        super.init()
        listener.delegate = self
    }

    public func start() { listener.resume() }
    public func stop() { listener.invalidate() }

    public func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Require Apple's engine host, not just a process claiming to use our protocol.
        // These identifiers were verified against the host bundle metadata on macOS 26.2.
        connection.setCodeSigningRequirement("anchor apple and (identifier \"com.apple.authorizationhost\" or identifier \"com.apple.SecurityAgent\" or identifier \"com.apple.SecurityAgentHelper-arm64\" or identifier \"com.apple.SecurityAgentHelper-x86_64\")")
        connection.exportedInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        connection.exportedObject = gate
        connection.resume()
        return true
    }
}

private final class AuthorizationGate: NSObject, LockedUseAuthorizing {
    private let queue = DispatchQueue(label: "dev.ace.locked-use.authorization.decisions")
    private let now: () -> UInt64
    private let verify: (LockedUsePluginRequest) -> Bool
    private var consumed: [UUID: UInt64] = [:]

    init(now: @escaping () -> UInt64, verify: @escaping (LockedUsePluginRequest) -> Bool) {
        self.now = now
        self.verify = verify
    }

    func authorize(attempt: String, transaction: Data, request: String, deadline: UInt64, reply: @escaping (Bool) -> Void) {
        queue.async { [self] in
            let at = now()
            consumed = consumed.filter { $0.value > at }
            guard !attempt.isEmpty, attempt.utf8.count <= 256,
                  attempt.rangeOfCharacter(from: .controlCharacters) == nil,
                  transaction.count == MemoryLayout<UnsafeRawPointer>.size,
                  let requestID = UUID(uuidString: request), consumed[requestID] == nil, consumed.count < 4096,
                  deadline > at, deadline - at <= 750_000_000 else { reply(false); return }
            consumed[requestID] = deadline
            let facts = LockedUsePluginRequest(attempt: attempt, transaction: transaction, requestID: requestID, deadline: deadline)
            let allowed = verify(facts)
            // A verifier may never turn a late callback into an authorization grant.
            reply(allowed && now() < deadline)
        }
    }
}
