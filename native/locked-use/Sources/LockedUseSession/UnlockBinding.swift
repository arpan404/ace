import Foundation
import LockedUseIPC

/// Binds the plug-in's opaque engine transaction to the one unlock request this driver
/// issued for an approved attempt. A request is accepted only while that request is
/// pending, only for its attempt id, and only for the first transaction that claims it.
///
/// Caveat: the engine transaction cannot be proven to belong to this process's own
/// AuthorizationRef. The attempt id must therefore be unguessable and single-use.
public struct LockedUseUnlockBinding: Sendable {
    /// Matches the authority's one-second authorization window.
    public static let window: UInt64 = 1_000_000_000
    private var attempt: String?
    private var until: UInt64 = 0
    private var transaction: Data?

    public init() {}

    public var pending: Bool { attempt != nil }

    public mutating func open(attempt: String, now: UInt64) {
        self.attempt = attempt
        let (sum, overflow) = now.addingReportingOverflow(Self.window)
        until = overflow ? UInt64.max : sum
        transaction = nil
    }

    public mutating func close(attempt: String) {
        guard self.attempt == attempt else { return }
        self.attempt = nil
        // The claimed transaction stays recorded so a late duplicate still cannot rebind.
    }

    public mutating func claim(_ request: LockedUsePluginRequest, attempt expected: String, now: UInt64) -> Bool {
        guard let attempt, attempt == expected, request.attempt == expected, now < until,
              !request.transaction.isEmpty else { return false }
        if let transaction { return transaction == request.transaction }
        transaction = request.transaction
        return true
    }
}
