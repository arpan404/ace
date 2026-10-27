import AppKit
import CoreGraphics
import LockedUseCore

/// One on-screen window, in the window server's front-to-back order.
public struct LockedUseWindowFact: Equatable, Sendable {
    public let pid: Int32
    public let bounds: CGRect
    public let alpha: Double
    public init(pid: Int32, bounds: CGRect, alpha: Double) { self.pid = pid; self.bounds = bounds; self.alpha = alpha }
}

/// Independent ordering check for the covers: on every display, the frontmost visible
/// window that is not the OS lock screen must be a cover owned by `coverPID` spanning the
/// whole display. Anything else fails closed.
public func lockedUseCoversAreFrontmost(_ windows: [LockedUseWindowFact], displays: [CGRect], coverPID: Int32,
                                        lockScreenPIDs: Set<Int32>) -> Bool {
    guard !displays.isEmpty, coverPID > 0 else { return false }
    return displays.allSatisfy { display in
        guard !display.isEmpty, let front = windows.first(where: {
            $0.alpha > 0 && $0.bounds.intersects(display) && !lockScreenPIDs.contains($0.pid)
        }) else { return false }
        return front.pid == coverPID && front.bounds.contains(display)
    }
}

/// Reads the live window list. Window ordering reads need no screen-recording permission
/// for owner pid, bounds and alpha. loginwindow is identified by bundle id, not by name.
@MainActor public func lockedUseVerifyCoverOrdering(_ displays: LockedUseDisplays) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
    let windows = list.compactMap { entry -> LockedUseWindowFact? in
        guard let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let raw = entry[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return LockedUseWindowFact(pid: pid, bounds: bounds, alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }
    let lockScreen = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.loginwindow").map(\.processIdentifier))
    return lockedUseCoversAreFrontmost(windows, displays: displays.ids.map { CGDisplayBounds($0) },
        coverPID: ProcessInfo.processInfo.processIdentifier, lockScreenPIDs: lockScreen)
}
