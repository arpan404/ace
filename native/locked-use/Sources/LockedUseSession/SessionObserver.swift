import LockedUseCore
import LockedUseRuntime
import LockedUseSystem

/// Re-reads the GUI session on every pulse and reports transitions. OS notifications may
/// call `poll()` early, but they are only wake-ups; state always comes from a fresh read.
@MainActor public final class LockedUseSessionObserver {
    public private(set) var manualUnlockGeneration: UInt64 = 0
    /// Called with the watched scope's new state. The coordinator re-reads the driver itself.
    public var onScopeState: ((LockedUseScope, LockedUseSessionState) -> Void)?
    /// Called when the person unlocks while no attempt is active.
    public var onManualUnlock: ((UInt64) -> Void)?
    public var onSessionState: ((LockedUseSessionState) -> Void)?
    private let read: () -> LockedUseSessionFacts?
    private var scope: LockedUseScope?
    private var scopeState: LockedUseSessionState?
    private var sessionState: LockedUseSessionState?

    public init(read: @escaping () -> LockedUseSessionFacts?) { self.read = read }

    public var current: LockedUseSessionFacts? { read() }

    public func watch(_ scope: LockedUseScope?) {
        self.scope = scope
        scopeState = scope.map { lockedUseSessionState(read(), for: $0) }
    }

    public func poll() {
        let facts = read()
        let session = lockedUseSessionState(facts)
        if session != sessionState {
            let previous = sessionState
            sessionState = session
            onSessionState?(session)
            if scope == nil, previous == .locked, session == .unlocked, manualUnlockGeneration < UInt64.max {
                manualUnlockGeneration += 1
                onManualUnlock?(manualUnlockGeneration)
            }
        }
        guard let scope else { return }
        let state = lockedUseSessionState(facts, for: scope)
        guard state != scopeState else { return }
        scopeState = state
        onScopeState?(scope, state)
    }
}
