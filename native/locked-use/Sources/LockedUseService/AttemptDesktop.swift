import LockedUseCore
import LockedUseRuntime

/// The coordinator keeps one desktop for its lifetime, but the agent process ids used for
/// takeover classification belong to each approved turn. This forwards to the desktop built
/// for the current attempt; without one, every protection query fails closed.
@MainActor final class LockedUseAttemptDesktop: LockedUseDesktop {
    enum Missing: Error { case noAttempt }
    var current: LockedUseDesktop?

    func displays() throws -> LockedUseDisplays {
        guard let current else { throw Missing.noAttempt }
        return try current.displays()
    }

    func prepare(_ scope: LockedUseScope) throws {
        guard let current else { throw Missing.noAttempt }
        try current.prepare(scope)
    }

    func protection() throws -> LockedUseProtection {
        guard let current else { throw Missing.noAttempt }
        return try current.protection()
    }

    func showWorking() { current?.showWorking() }
    func showRelocking() { current?.showRelocking() }
    func removeAfterConfirmedLock() { current?.removeAfterConfirmedLock() }
}
