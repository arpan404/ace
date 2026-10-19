import AppKit
import ApplicationServices

// TEMPORARY: minimal stand-ins for the CUAppSession APIs SWIFT-ENGINE adds in
// ComputerSession.swift. Delete this file (and its Package.swift / build.sh entries) at merge.
extension CUAppSession {
    func screenPoint(fromPixel pixel: CGPoint) throws -> CGPoint { try globalPoint(x: pixel.x, y: pixel.y) }

    func element(atScreen point: CGPoint) -> AXUIElement? {
        var hit: AXUIElement?
        return AXUIElementCopyElementAtPosition(element, Float(point.x), Float(point.y), &hit) == .success ? hit : nil
    }

    func node(for element: AXUIElement) -> CUNode? {
        guard let id = registry.existingId(for: element) else { return nil }
        return lastNodes.first { $0.id == id }
    }

    func refreshNodes() -> [CUNode] {
        _ = observe(windows: cuWindows(pid: pid))
        return lastNodes
    }
}
