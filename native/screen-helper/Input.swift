import AppKit
import ApplicationServices
import ScreenCaptureKit

extension Capture {
    func inject(_ action: Action) async throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { throw HelperError("macOS permission denied") }
        guard let target, target.kind != "display", let bundle = target.bundleId, allowed.contains(bundle) else { throw HelperError("Approved controllable target required") }
        let content = try await content()
        let candidates = content.windows.filter { $0.owningApplication?.bundleIdentifier == bundle }
        let window: SCWindow?
        if target.kind == "window" { window = candidates.first { $0.windowID == target.windowId } }
        else { window = candidates.first }
        guard let window, let app = window.owningApplication else { throw HelperError("Target no longer available") }
        if target.kind == "window" { try requireFocusedWindow(window, candidates: candidates) }
        var location = CGPoint.zero
        if action.kind == "click" || action.kind == "scroll" {
            guard let x = action.x, let y = action.y, x.isFinite, y.isFinite,
                  x >= 0, y >= 0, x < Double(width), y < Double(height) else { throw HelperError("Input outside capture bounds") }
            let bounds = target.kind == "window" ? window.frame : frame
            location = CGPoint(x: bounds.minX + x * bounds.width / Double(width), y: bounds.minY + y * bounds.height / Double(height))
            guard candidates.contains(where: { $0.frame.contains(location) }) else { throw HelperError("Input outside approved application") }
        }
        func post(_ event: CGEvent?) throws {
            guard let event else { throw HelperError("Cannot create input event") }
            event.postToPid(app.processID)
        }
        switch action.kind {
        case "click":
            guard action.button == "left" || action.button == "right" else { throw HelperError("Invalid mouse button") }
            let right = action.button == "right"
            try post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: location, mouseButton: right ? .right : .left))
            try post(CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: location, mouseButton: right ? .right : .left))
        case "type":
            guard let text = action.text, text.utf16.count <= 8192 else { throw HelperError("Text exceeds limit") }
            let characters = Array(text.utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw HelperError("Cannot create keyboard event") }
                characters.withUnsafeBufferPointer { buffer in
                    if let base = buffer.baseAddress { event.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: base) }
                }
                try post(event)
            }
        case "key":
            guard let code = action.keyCode, code <= 127, let modifiers = action.modifiers, modifiers.count <= 4 else { throw HelperError("Invalid key") }
            var flags = CGEventFlags()
            for modifier in modifiers {
                switch modifier {
                case "command": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "option": flags.insert(.maskAlternate)
                case "control": flags.insert(.maskControl)
                default: throw HelperError("Invalid modifier")
                }
            }
            for down in [true, false] { let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); event?.flags = flags; try post(event) }
        case "scroll":
            guard let dx = action.deltaX, let dy = action.deltaY, abs(Int(dx)) <= 1000, abs(Int(dy)) <= 1000 else { throw HelperError("Invalid scroll") }
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
            event?.location = location; try post(event)
        default: throw HelperError("Unsupported input")
        }
    }
}
