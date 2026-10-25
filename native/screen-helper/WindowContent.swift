import ApplicationServices
import CoreGraphics

/// The apps whose windows show an iOS Simulator device: Simulator, and the device tool that
/// replaces it in newer Xcode.
let simulatorWindowBundles: Set<String> = ["com.apple.iphonesimulator", "com.apple.dt.Devices"]

/// How far a window's title bar and toolbar reach below its top edge, in points, from the frames
/// of their parts. 0 when no part sits in the top of the window, or cropping would leave too
/// little: the capture then keeps the whole window.
func titleBarDepth(window: CGRect, parts: [CGRect]) -> Double {
    let depth = parts
        .filter { $0.height > 0 && $0.minY >= window.minY - 1 && $0.minY < window.minY + window.height / 4 }
        .map { $0.maxY - window.minY }
        .max() ?? 0
    guard depth > 0, depth < window.height / 3 else { return 0 }
    return depth.rounded(.up)
}

/// The title bar's parts among a window's own children: its window buttons and its toolbar.
func titleBarParts(_ window: AXUIElement) -> [CGRect] {
    let buttons: Set<String> = [kAXCloseButtonSubrole, kAXMinimizeButtonSubrole, kAXZoomButtonSubrole, kAXFullScreenButtonSubrole]
    return axChildren(window, maximum: 64).compactMap { child in
        let role = axAttribute(child, kAXRoleAttribute) as? String
        let subrole = axAttribute(child, kAXSubroleAttribute) as? String
        guard role == kAXToolbarRole || subrole.map(buttons.contains) == true else { return nil }
        return axBounds(child).rect
    }
}

/// `bounds` without the top `inset`: the part of a window a content-only capture shows.
func contentBounds(_ bounds: CGRect, inset: Double) -> CGRect {
    guard inset > 0, inset < bounds.height else { return bounds }
    return CGRect(x: bounds.minX, y: bounds.minY + inset, width: bounds.width, height: bounds.height - inset)
}
