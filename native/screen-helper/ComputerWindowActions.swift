import AppKit
import ApplicationServices

/// Window operations through the window's own AX attributes and buttons. None of them
/// activates the app or moves the person's focus.
extension CUActor {
    func windowOp(_ action: CUObject) async throws -> String {
        guard let window = session.window?.element else { throw CUError("no_window", "\(session.name) has no open window.") }
        let op = action.string("op") ?? ""
        let title = cuClip(cuAttribute(window, "AXTitle") as? String, 60).map { " \"\($0)\"" } ?? ""
        switch op {
        case "close":
            try await pressButton(window, "AXCloseButton", op: op)
            return "closed the window\(title) (if it has unsaved changes, the app now asks what to do)"
        case "minimize":
            try setWindow(window, "AXMinimized", kCFBooleanTrue, op: op)
            return "minimized the window\(title)"
        case "restore":
            if cuAttribute(window, "AXFullScreen") as? Bool == true { try setWindow(window, "AXFullScreen", kCFBooleanFalse, op: op) }
            if cuAttribute(window, "AXMinimized") as? Bool == true { try setWindow(window, "AXMinimized", kCFBooleanFalse, op: op) }
            return "restored the window\(title)"
        case "zoom":
            if let button = cuAttribute(window, "AXZoomButton").map({ $0 as! AXUIElement }) { try await perform(button, "AXPress") }
            else if cuActionNames(window).contains("AXZoomWindow") { try await perform(window, "AXZoomWindow") }
            else { throw CUError("not_supported", "This window can't be zoomed.") }
            return "zoomed the window\(title)\(frameNote(window))"
        case "fullscreen":
            try setWindow(window, "AXFullScreen", kCFBooleanTrue, op: op)
            return "put the window\(title) in full screen (it moves to its own Space; window restore leaves it)"
        case "raise":
            try await perform(window, "AXRaise")
            return "raised the window\(title) within \(session.name), without activating the app"
        case "move":
            guard let x = action.double("x"), let y = action.double("y") else { throw CUError("bad_action", "window move needs x and y in screen points (top-left origin).") }
            var origin = CGPoint(x: x, y: y)
            guard let value = AXValueCreate(.cgPoint, &origin) else { throw CUError("bad_action", "Bad position.") }
            try setWindow(window, "AXPosition", value, op: op)
            return "moved the window\(title)\(frameNote(window))"
        case "resize":
            guard let width = action.double("width"), let height = action.double("height"), width > 0, height > 0 else {
                throw CUError("bad_action", "window resize needs width and height in points.")
            }
            var size = CGSize(width: width, height: height)
            guard let value = AXValueCreate(.cgSize, &size) else { throw CUError("bad_action", "Bad size.") }
            try setWindow(window, "AXSize", value, op: op)
            return "resized the window\(title)\(frameNote(window))"
        default:
            throw CUError("bad_action", "window op is close, minimize, restore, zoom, fullscreen, raise, move or resize.")
        }
    }

    private func pressButton(_ window: AXUIElement, _ attribute: String, op: String) async throws {
        guard let button = cuAttribute(window, attribute).map({ $0 as! AXUIElement }) else {
            throw CUError("not_supported", "This window has no \(op) button.")
        }
        try await perform(button, "AXPress")
    }

    private func setWindow(_ window: AXUIElement, _ attribute: String, _ value: CFTypeRef, op: String) throws {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(window, attribute as CFString, &settable) == .success, settable.boolValue else {
            throw CUError("not_supported", "\(session.name) does not let this window \(op).")
        }
        let result = AXUIElementSetAttributeValue(window, attribute as CFString, value)
        guard result == .success else { throw CUError("action_failed", "\(session.name) refused to \(op) the window (AX error \(result.rawValue)).") }
        session.settler.markChanged()
    }

    /// Where the window ended up; apps may constrain a move or resize.
    private func frameNote(_ window: AXUIElement) -> String {
        guard let frame = cuFrame(of: window) else { return "" }
        return "; it is now at (\(Int(frame.minX)), \(Int(frame.minY))), \(Int(frame.width))×\(Int(frame.height))"
    }
}
