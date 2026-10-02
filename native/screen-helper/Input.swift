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
        guard let window, window.owningApplication != nil else { throw HelperError("Target no longer available") }
        var location = CGPoint.zero
        var inputWindow = window
        if action.kind == "click" || action.kind == "scroll" {
            guard let x = action.x, let y = action.y, x.isFinite, y.isFinite,
                  x >= 0, y >= 0, x < Double(width), y < Double(height) else { throw HelperError("Input outside capture bounds") }
            let bounds = target.kind == "window" ? window.frame : frame
            location = CGPoint(x: bounds.minX + x * bounds.width / Double(width), y: bounds.minY + y * bounds.height / Double(height))
            guard let hit = candidates.first(where: { $0.frame.contains(location) }) else { throw HelperError("Input outside approved application") }
            inputWindow = hit
        }
        if target.kind == "window" { try requireFocusedWindow(window, candidates: candidates) }
        func post(_ event: CGEvent?) throws {
            guard let event else { throw HelperError("Cannot create input event") }
            if action.kind == "click" || action.kind == "scroll" {
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(inputWindow.windowID))
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(inputWindow.windowID))
                if action.kind == "click" { event.setIntegerValueField(.mouseEventClickState, value: 1) }
            }
            guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), let pid = inputWindow.owningApplication?.processID else { throw HelperError("macOS permission denied or target unavailable") }
            event.postToPid(pid)
        }
        func pointer(_ type: NSEvent.EventType) throws -> CGEvent {
            // NSEvent cannot look up this foreign NSWindow. Compensate for its screen-to-window Y conversion.
            let local = CGPoint(x: location.x - inputWindow.frame.minX, y: inputWindow.frame.maxY - location.y)
            let point = CGPoint(x: local.x, y: local.y + CGDisplayBounds(CGMainDisplayID()).height - inputWindow.frame.height)
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(inputWindow.windowID), context: nil, eventNumber: 0, clickCount: 1, pressure: 1)?.cgEvent else { throw HelperError("Cannot create targeted pointer event") }
            return event
        }
        switch action.kind {
        case "click":
            guard action.button == "left" || action.button == "right" else { throw HelperError("Invalid mouse button") }
            let right = action.button == "right"
            for type: NSEvent.EventType in right ? [.rightMouseDown, .rightMouseUp] : [.leftMouseDown, .leftMouseUp] {
                try post(try pointer(type))
            }
        case "type":
            guard let text = action.text, text.utf16.count <= 8192 else { throw HelperError("Text exceeds limit") }
            if text.isEmpty { return }
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
            let event = try pointer(.leftMouseDown)
            event.type = .scrollWheel
            event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            event.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: Int64(dy))
            event.setIntegerValueField(.scrollWheelEventDeltaAxis2, value: Int64(dx))
            event.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(dy))
            event.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(dx))
            event.setIntegerValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Int64(dy) * 65536)
            event.setIntegerValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Int64(dx) * 65536)
            try post(event)
        default: throw HelperError("Unsupported input")
        }
    }
}
