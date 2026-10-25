import Foundation

/// A physical display can mirror another display's rendered surface. Every online display
/// must map to a covered surface; checking only NSScreen.count misses mirror topology changes.
public struct LockedUseDisplaySurface: Equatable, Sendable {
    public let displayID: UInt32
    public let renderedBy: UInt32

    public init(displayID: UInt32, renderedBy: UInt32) {
        self.displayID = displayID
        self.renderedBy = renderedBy
    }
}

public func lockedUseHasCompleteCoverage(_ displays: [LockedUseDisplaySurface], covered: Set<UInt32>) -> Bool {
    guard !displays.isEmpty, displays.count <= 32,
          Set(displays.map(\.displayID)).count == displays.count else { return false }
    return displays.allSatisfy { $0.displayID != 0 && $0.renderedBy != 0 && covered.contains($0.renderedBy) }
}
