import Foundation

/// Whether the phone may read likely threads ahead (ADR 0128): only on a roomy network (online,
/// unmetered, not Low Data Mode) and outside Low Power Mode. Tells `changed` each time that flips.
@MainActor final class ReadAheadGate {
    var changed: ((Bool) -> Void)?
    var roomy = false { didSet { decide() } }
    private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    private var allowed = false
    private var observer: NSObjectProtocol?

    static func allows(roomy: Bool, lowPower: Bool) -> Bool { roomy && !lowPower }

    func start() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
                self?.decide()
            }
        }
        decide()
    }

    private func decide() {
        let next = Self.allows(roomy: roomy, lowPower: lowPower)
        guard next != allowed else { return }
        allowed = next
        changed?(next)
    }
}
