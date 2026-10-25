import Foundation
import IOKit.pwr_mgt

/// System sleep protection survives the gaps between tool calls. Display protection is
/// limited to a batch on an unlocked desktop. Neither assertion unlocks a Mac, prevents
/// explicit sleep, or overrides closing the lid. The OS watchdog also covers a stuck helper.
@MainActor final class CUAwake {
    typealias After = (TimeInterval, @escaping () -> Void) -> () -> Void
    private let after: After
    private var system: IOPMAssertionID?
    private var display: IOPMAssertionID?
    private var stopExpiry: (() -> Void)?
    private var revision = 0

    init(after: @escaping After = CUAwake.schedule) { self.after = after }

    func hold() throws {
        revision &+= 1
        stopExpiry?()
        stopExpiry = nil
        if let system, IOPMAssertionSetProperty(system, kIOPMAssertionTimeoutKey as CFString, NSNumber(value: 360)) != kIOReturnSuccess {
            IOPMAssertionRelease(system)
            self.system = nil
        }
        if system == nil { system = try assertion(kIOPMAssertPreventUserIdleSystemSleep as CFString) }
    }

    func keepDisplayAwake() throws {
        if display == nil { display = try assertion(kIOPMAssertPreventUserIdleDisplaySleep as CFString) }
    }

    /// Matches the app helper pool's default five-minute idle lifetime. A subsequent call
    /// renews this lease; cancel, failure, shutdown and expiry release it.
    func linger() {
        if let display { IOPMAssertionRelease(display); self.display = nil }
        stopExpiry?()
        revision &+= 1
        let scheduledRevision = revision
        stopExpiry = after(300) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.revision == scheduledRevision else { return }
                self.release()
            }
        }
    }

    func release() {
        revision &+= 1
        stopExpiry?()
        stopExpiry = nil
        if let display { IOPMAssertionRelease(display); self.display = nil }
        if let system { IOPMAssertionRelease(system); self.system = nil }
    }

    private func assertion(_ type: CFString) throws -> IOPMAssertionID {
        var id: IOPMAssertionID = 0
        let status = IOPMAssertionCreateWithDescription(type, "ace computer use" as CFString,
            "Keeping agent work running between computer-use calls" as CFString, nil, nil,
            360, kIOPMAssertionTimeoutActionRelease as CFString, &id)
        guard status == kIOReturnSuccess else {
            throw CUError("power_assertion_failed", "macOS could not keep the Mac awake for computer use (\(status)). Try again before leaving the Mac unattended.")
        }
        return id
    }

    nonisolated private static func schedule(_ seconds: TimeInterval, _ run: @escaping () -> Void) -> () -> Void {
        let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in run() }
        return { timer.invalidate() }
    }
}
