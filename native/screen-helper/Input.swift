import AppKit
import ApplicationServices
import ScreenCaptureKit

extension Capture {
    /// Press a button of the captured window by its accessible name: Simulator's Home, Rotate and
    /// side buttons, which keyboard shortcuts reach only while Simulator is the active app.
    func pressButton(_ name: String) async throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { throw HelperError("macOS permission denied", code: "permission_denied") }
        guard name.count <= 64, let target, target.kind == "window", let bundle = target.bundleId, allowed.contains(bundle) else { throw HelperError("Approved window target required", code: "permission_denied") }
        let candidates = try await content().windows.filter { $0.owningApplication?.bundleIdentifier == bundle }
        guard let window = candidates.first(where: { $0.windowID == target.windowId }) else { throw HelperError("Target no longer available", code: "target_gone") }
        let element: AXUIElement
        if let focused = try? focusedWindowElement(window, candidates: candidates) { element = focused }
        else { try await focusWindow(window); element = try focusedWindowElement(window, candidates: candidates) }
        guard let button = windowButton(element, named: name) else { throw HelperError("The window has no \(name) button", code: "not_supported") }
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw HelperError("Could not press \(name)", code: "internal") }
    }
    /// Keys and window buttons go to the app's focused window, and a background app (Simulator
    /// behind ace) may have another of its windows focused. A click on the captured window's title
    /// bar focuses it without activating the app, so the person stays where they are.
    func focusWindow(_ window: SCWindow) async throws {
        var focus = Action(kind: "click")
        focus.coordinates = .windowPoints
        focus.focusFirst = false
        focus.x = try currentWindowBounds(window).width / 2; focus.y = 16; focus.button = "left"
        try await inject(focus)
        try await Task.sleep(nanoseconds: 100_000_000)
    }
    func inject(_ action: Action) async throws {
        // Permission is checked immediately before every event is posted below, after any
        // asynchronous focus/discovery. Avoid duplicating the TCC query on the pointer path.
        guard let target, target.kind != "display", let bundle = target.bundleId, allowed.contains(bundle) else { throw HelperError("Approved controllable target required", code: "permission_denied") }
        let candidates: [SCWindow]
        if target.kind == "window", ["click", "scroll", "move", "down", "drag", "up"].contains(action.kind), let captureWindow {
            // Capture owns this SCWindow. Bounds/owner/overlap are verified from live CG rows
            // below; enumerating ScreenCaptureKit targets on every pointer event stalls input.
            candidates = [captureWindow]
        } else { candidates = try await content().windows.filter { $0.owningApplication?.bundleIdentifier == bundle } }
        let window: SCWindow?
        if target.kind == "window" { window = candidates.first { $0.windowID == target.windowId } }
        else { window = candidates.first }
        guard let window, window.owningApplication != nil else { throw HelperError("Target no longer available", code: "target_gone") }
        guard candidates.count <= 128 else { throw HelperError("Input window limit reached; use semantic actions", code: "busy") }
        var location = CGPoint.zero
        var inputWindow = window
        var pointerBounds: CGRect?
        if ["click", "scroll", "move", "down", "drag", "up"].contains(action.kind) {
            let geometry = target.kind == "window" ? try pointerGeometry(window) : nil
            let bounds = geometry?.bounds ?? frame
            pointerBounds = bounds
            let pointCoordinates = action.coordinates == .windowPoints && target.kind == "window"
            let x = action.x ?? (pointCoordinates && action.kind == "scroll" ? bounds.width / 2 : -1)
            let y = action.y ?? (pointCoordinates && action.kind == "scroll" ? bounds.height / 2 : -1)
            let limitX = pointCoordinates ? bounds.width : Double(width), limitY = pointCoordinates ? bounds.height : Double(height)
            guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < limitX, y < limitY else { throw HelperError("Input outside capture bounds", code: "bounds") }
            location = CGPoint(x: bounds.minX + x * bounds.width / limitX, y: bounds.minY + y * bounds.height / limitY)
            if target.kind == "window" {
                guard bounds.contains(location) else { throw HelperError("Input outside captured window", code: "bounds") }
                // Only a window of the same app stacked in front of this one could take the event.
                guard !(geometry?.front.contains(where: { $0.contains(location) }) ?? true) else { throw HelperError("Captured window overlaps another application window", code: "bounds") }
                inputWindow = window
            } else {
                let hits = candidates.filter { $0.frame.contains(location) && (action.windowId == nil || $0.windowID == action.windowId) }
                guard hits.count == 1, let hit = hits.first else { throw HelperError("Input outside or ambiguous within approved application", code: "bounds") }
                inputWindow = hit
            }
        }
        // A background app may treat the first click on an unfocused window as focusing only.
        if target.kind == "window", action.focusFirst, ["click", "down", "scroll"].contains(action.kind),
           (try? requireFocusedWindow(window, candidates: candidates)) == nil {
            try await focusWindow(window)
        }
        // Pointer events carry an explicit window number. Keyboard events follow focus.
        if target.kind == "window" && !["click", "scroll", "move", "down", "drag", "up"].contains(action.kind) {
            // An app in the background has no key window, so its windows drop key events (taps
            // and window buttons still work). Say so instead of typing into nothing.
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == window.owningApplication?.processID else {
                throw HelperError("Keys reach \(window.owningApplication?.applicationName ?? "the app") only while it is the frontmost app", code: "not_supported")
            }
            if (try? requireFocusedWindow(window, candidates: candidates)) == nil {
                try await focusWindow(window)
                try requireFocusedWindow(window, candidates: candidates)
            }
        }
        func post(_ event: CGEvent?) throws {
            guard let event else { throw HelperError("Cannot create input event") }
            if ["click", "scroll", "move", "down", "drag", "up"].contains(action.kind) {
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(inputWindow.windowID))
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(inputWindow.windowID))
                if action.kind == "click" { event.setIntegerValueField(.mouseEventClickState, value: 1) }
            }
            guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), let pid = inputWindow.owningApplication?.processID, NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bundle else { throw HelperError("macOS permission denied or target unavailable", code: "permission_denied") }
            event.postToPid(pid)
        }
        func pointer(_ type: NSEvent.EventType) throws -> CGEvent {
            // NSEvent cannot look up this foreign NSWindow. Compensate for its screen-to-window Y conversion.
            let current = try pointerBounds ?? currentWindowBounds(inputWindow)
            let local = CGPoint(x: location.x - current.minX, y: current.maxY - location.y)
            let point = CGPoint(x: local.x, y: local.y + CGDisplayBounds(CGMainDisplayID()).height - current.height)
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
        case "move", "down", "drag", "up":
            let right = action.button == "right"
            let type: NSEvent.EventType = action.kind == "move" ? .mouseMoved : action.kind == "down" ? (right ? .rightMouseDown : .leftMouseDown) : action.kind == "drag" ? (right ? .rightMouseDragged : .leftMouseDragged) : (right ? .rightMouseUp : .leftMouseUp)
            try post(try pointer(type))
            if action.kind == "down" || action.kind == "drag" { pointerAction = action }
            if action.kind == "up" { pointerAction = nil }
        case "type":
            guard let text = action.text, text.utf16.count <= 4096 else { throw HelperError("Text exceeds limit", code: "bounds") }
            if text.isEmpty {
                guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { throw HelperError("macOS permission denied", code: "permission_denied") }
                return
            }
            // One key per character. Mac apps read the Unicode string; Simulator and other apps
            // that read the hardware key need its key code and Shift, so both are set.
            for character in text {
                let units = Array(String(character).utf16)
                let key = usKeys[character]
                // Simulator follows Shift's own key events, not just the flag on the character.
                func shift(_ down: Bool) throws {
                    guard key?.shift == true, let event = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: down) else { return }
                    event.type = .flagsChanged
                    event.flags = down ? .maskShift : []
                    try post(event)
                }
                try shift(true)
                defer { try? shift(false) }
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: key?.code ?? 0, keyDown: down) else { throw HelperError("Cannot create keyboard event") }
                    if key?.shift == true { event.flags = .maskShift }
                    units.withUnsafeBufferPointer { buffer in
                        if let base = buffer.baseAddress { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base) }
                    }
                    try post(event)
                }
            }
        case "key":
            guard let code = action.keyCode, code <= 127, let modifiers = action.modifiers, modifiers.count <= 4 else { throw HelperError("Invalid key", code: "bounds") }
            var flags = CGEventFlags()
            for modifier in modifiers {
                switch modifier {
                case "command": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "option": flags.insert(.maskAlternate)
                case "control": flags.insert(.maskControl)
                default: throw HelperError("Invalid modifier", code: "bounds")
                }
            }
            for down in [true, false] { let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); event?.flags = flags; try post(event) }
        case "scroll":
            guard let dx = action.deltaX, let dy = action.deltaY, abs(Int(dx)) <= 1000, abs(Int(dy)) <= 1000 else { throw HelperError("Invalid scroll", code: "bounds") }
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
        default: throw HelperError("Unsupported input", code: "not_supported")
        }
    }
}

/// US ANSI key codes for printable ASCII, with whether Shift is held.
let usKeys: [Character: (code: CGKeyCode, shift: Bool)] = {
    var keys: [Character: (code: CGKeyCode, shift: Bool)] = [:]
    let plain: [(String, CGKeyCode)] = [
        ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9), ("b", 11), ("q", 12),
        ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23),
        ("=", 24), ("9", 25), ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31), ("u", 32), ("[", 33), ("i", 34),
        ("p", 35), ("l", 37), ("j", 38), ("'", 39), ("k", 40), (";", 41), ("\\", 42), (",", 43), ("/", 44), ("n", 45), ("m", 46),
        (".", 47), ("`", 50), (" ", 49), ("\n", 36), ("\t", 48),
    ]
    let shifted: [(String, String)] = [
        ("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"), ("(", "9"), (")", "0"),
        ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"), ("\"", "'"), ("<", ","), (">", "."), ("?", "/"), ("~", "`"),
    ]
    for (character, code) in plain {
        guard let key = character.first else { continue }
        keys[key] = (code, false)
        if key.isLetter, let upper = key.uppercased().first { keys[upper] = (code, true) }
    }
    for (character, base) in shifted {
        guard let key = character.first, let plainKey = base.first, let code = keys[plainKey]?.code else { continue }
        keys[key] = (code, true)
    }
    return keys
}()
