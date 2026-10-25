import Foundation
import LockedUseCore
import LockedUseUI

/// Connects the real AppKit covers and HID guard to the coordinator. The host supplies
/// an independent window-ordering verifier; panel visibility never supplies that proof.
/// Construction does not open windows, suppress input, or ask for OS permissions.
@MainActor public final class LockedUseNativeDesktop: LockedUseDesktop {
    private let agentProcessIDs: Set<Int32>
    private let verifyOrdering: (LockedUseDisplays) -> Bool
    private let takeover: (LockedUseScope) -> Void
    private let lost: (LockedUseScope) -> Void
    private var scope: LockedUseScope?
    private lazy var cover = LockedUseDisplayCover { [weak self] in self?.reportLost() }
    private lazy var input = LockedUseInputGuard(agentProcessIDs: agentProcessIDs,
        takeover: { [weak self] in
            guard let self, let scope else { return }
            takeover(scope)
        }, protectionLost: { [weak self] in self?.reportLost() })

    public init(agentProcessIDs: Set<Int32>, verifyOrdering: @escaping (LockedUseDisplays) -> Bool,
                takeover: @escaping (LockedUseScope) -> Void, protectionLost: @escaping (LockedUseScope) -> Void) {
        self.agentProcessIDs = agentProcessIDs
        self.verifyOrdering = verifyOrdering
        self.takeover = takeover
        lost = protectionLost
    }

    public func displays() throws -> LockedUseDisplays { try cover.plannedDisplays() }

    public func prepare(_ scope: LockedUseScope) throws {
        self.scope = scope
        _ = try cover.prepare()
        try input.start()
    }

    public func protection() throws -> LockedUseProtection {
        let displays = try cover.topologyAcknowledgement()
        return LockedUseProtection(displays: displays,
            inputGuardReady: input.ready && verifyOrdering(displays), relockGuardReady: true)
    }

    public func showWorking() { cover.showWorking() }
    public func showRelocking() { cover.showRelocking() }

    public func removeAfterConfirmedLock() {
        input.stopAfterConfirmedLock()
        cover.removeAfterConfirmedLock()
        scope = nil
    }

    private func reportLost() {
        guard let scope else { return }
        lost(scope)
    }
}
