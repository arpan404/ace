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
        if mode == "foreground" { try await foregroundWindow(window) }
        let element = try resolver.resolve(window)
        guard let button = windowButton(element, named: name, clock: runtime.nanos) else { throw HelperError("The window has no \(name) button", code: "not_supported") }
        dispatched = true
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw HelperError("Could not press \(name)", code: "internal") }
        deliveryConfirmed = true
    }
    func foregroundWindow(_ window: SCWindow) async throws {
        guard mode == "foreground", let pid = window.owningApplication?.processID, let app = NSRunningApplication(processIdentifier: pid) else { throw HelperError("Foreground approval required", code: "foreground_required") }
        // Resolve and validate before any activation, including before a Space switch.
        let element = try resolver.resolve(window)
        _ = try currentWindowBounds(window)
        guard axAttribute(element, kAXMinimizedAttribute) as? Bool != true else { throw HelperError("Target window is minimized", code: "window_minimized") }
        app.unhide()
        if keyboardApplicationPID() != pid {
            _ = app.activate(options: [])
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard keyboardApplicationPID() == pid else { throw HelperError("Could not activate approved target", code: "foreground_required") }
        guard AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success else { throw HelperError("Could not raise approved window", code: "not_supported") }
        let (focused, _) = try appFocusedWindow(pid)
        try resolver.requireDestination(focused, window: window)
    }
    func inject(_ action: Action) async throws {
        if action.kind == "down", pointerAction != nil { try releasePointer() }
        // Permission is checked immediately before every event is posted below, after any
        // asynchronous focus/discovery. Avoid duplicating the TCC query on the pointer path.
        guard let target, target.kind != "display", let bundle = target.bundleId, allowed.contains(bundle) else { throw HelperError("Approved controllable target required", code: "permission_denied") }
        let candidates: [SCWindow]
        if target.kind == "window", let captureWindow {
            // Capture owns this SCWindow. Bounds/owner/overlap are verified from live CG rows
            // below; enumerating ScreenCaptureKit targets on every pointer event stalls input.
            candidates = [captureWindow]
        } else { candidates = try await content().windows.filter { $0.owningApplication?.bundleIdentifier == bundle } }
        let window: SCWindow?
        if target.kind == "window" { window = candidates.first { $0.windowID == target.windowId } }
        else { window = try appInputWindow(candidates.filter { $0.windowLayer == 0 }) }
        guard let window, window.owningApplication != nil else { throw HelperError("Target no longer available", code: "target_gone") }
        guard candidates.count <= 128 else { throw HelperError("Input window limit reached; use semantic actions", code: "busy") }
        if mode == "foreground" {
            if ["click", "scroll", "move", "down", "drag", "up"].contains(action.kind) { try requireForegroundPointerDisplay(window) }
            try await foregroundWindow(window)
        }
        var location = CGPoint.zero
        var inputWindow = window
        var pointerBounds: CGRect?
        if ["click", "scroll", "move", "down", "drag", "up"].contains(action.kind) {
            let geometry = target.kind == "window" ? try pointerGeometry(window) : nil
            let pointCoordinates = action.coordinates == .windowPoints
            let bounds = try geometry?.bounds ?? (pointCoordinates ? currentWindowBounds(window) : frame)
            pointerBounds = bounds
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
            } else if pointCoordinates {
                guard action.windowId == window.windowID else { throw HelperError("App input focus changed", code: "target_gone") }
                inputWindow = window
            } else {
                let hits = candidates.filter { $0.frame.contains(location) && (action.windowId == nil || $0.windowID == action.windowId) }
                guard hits.count == 1, let hit = hits.first else { throw HelperError("Input outside or ambiguous within approved application", code: "bounds") }
                inputWindow = hit
            }
        }
        if mode == "background", bundle == "com.apple.iphonesimulator",
           ["type", "key", "paste"].contains(action.kind), !humanDeviceInput,
           keyboardApplicationPID() != window.owningApplication?.processID {
            throw HelperError("Background Simulator typing requires native idb HID", code: "foreground_required")
        }
        func post(_ event: CGEvent?) throws {
            guard let event else { throw HelperError("Cannot create input event") }
            if ["click", "scroll", "move", "down", "drag", "up"].contains(action.kind) {
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(inputWindow.windowID))
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(inputWindow.windowID))
                if action.kind == "click" { event.setIntegerValueField(.mouseEventClickState, value: 1) }
            }
            guard runtime.inputAllowed(), let pid = inputWindow.owningApplication?.processID, NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bundle else { throw HelperError("macOS permission denied or target unavailable", code: "permission_denied") }
            if ["type", "key", "paste"].contains(action.kind) { try destination().requireConsent(secureInputAllowed) }
            if mode == "background", ["type", "key", "paste"].contains(action.kind), !humanDeviceInput {
                try requireProcessKeyboardDestination(inputWindow, resolver: resolver)
            }
            try deliverInput(event, mode: mode, pid: pid, permission: runtime.inputAllowed) { event, destination in
                if destination == .foreground, ["type", "key", "paste"].contains(action.kind) {
                    let (focused, _) = try appFocusedWindow(pid)
                    let actualWindow = try self.resolver.identity(focused, pid: pid)
                    try verifyKeyboardDestination(expectedPID: pid, expectedWindow: inputWindow.windowID, actualPID: keyboardApplicationPID(), actualWindow: actualWindow)
                }
                self.measurementInputMark?()
                self.synthesizedInput = true; self.dispatched = true
                switch destination {
                case .foreground: event.location = location; event.post(tap: .cghidEventTap)
                case let .process(targetPid): event.postToPid(targetPid)
                }
            }
        }
        func pointer(_ type: NSEvent.EventType) throws -> CGEvent {
            // NSEvent cannot look up this foreign NSWindow. Compensate for its screen-to-window Y conversion.
            let current = try pointerBounds ?? currentWindowBounds(inputWindow)
            let local = CGPoint(x: location.x - current.minX, y: current.maxY - location.y)
            let point = CGPoint(x: local.x, y: local.y + CGDisplayBounds(CGMainDisplayID()).height - current.height)
            guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: runtime.uptime(), windowNumber: Int(inputWindow.windowID), context: nil, eventNumber: 0, clickCount: 1, pressure: 1)?.cgEvent else { throw HelperError("Cannot create targeted pointer event") }
            return event
        }
        var keyboardField: TextDestination?
        func destination() throws -> TextDestination {
            if let field = keyboardField, axAttribute(field.element, kAXFocusedAttribute) as? Bool == true {
                try resolver.requireDestination(field.element, window: inputWindow)
                return TextDestination(element: field.element, security: textSecurity(field.element))
            }
            let field = try windowTextDestination(inputWindow, resolver: resolver, foreground: mode == "foreground", clock: runtime.nanos)
            keyboardField = field
            return field
        }
        if ["key", "type", "paste"].contains(action.kind) {
            guard runtime.inputAllowed() else { throw HelperError("Input permission denied", code: "permission_denied") }
            let field = try destination(); try field.requireConsent(secureInputAllowed)
            let before = destinationState(field.element)
            deliveryProbe = {
                guard let current = try? destination(), CFEqual(current.element, field.element),
                      (try? current.requireConsent(self.secureInputAllowed)) != nil else { return false }
                let after = destinationState(current.element)
                if action.kind == "type" || action.kind == "paste", let count = before.count, let range = before.selection,
                   let text = action.text { return after.count == count - range.length + text.utf16.count }
                return after != before
            }
        }
        switch action.kind {
        case "click":
            guard action.button == "left" || action.button == "right" else { throw HelperError("Invalid mouse button") }
            let right = action.button == "right"
            if !humanDeviceInput, try performTargetedAXAction(inputWindow, at: location, names: [right ? "AXShowMenu" : kAXPressAction], beforeDispatch: { self.dispatched = true; self.measurementInputMark?() }) { deliveryConfirmed = true; return }
            for type: NSEvent.EventType in right ? [.rightMouseDown, .rightMouseUp] : [.leftMouseDown, .leftMouseUp] {
                try post(try pointer(type))
            }
        case "move", "down", "drag", "up":
            let right = action.button == "right"
            let type: NSEvent.EventType = action.kind == "move" ? .mouseMoved : action.kind == "down" ? (right ? .rightMouseDown : .leftMouseDown) : action.kind == "drag" ? (right ? .rightMouseDragged : .leftMouseDragged) : (right ? .rightMouseUp : .leftMouseUp)
            try post(try pointer(type))
            if action.kind == "down" || action.kind == "drag" {
                guard let pid = inputWindow.owningApplication?.processID,
                      let app = NSRunningApplication(processIdentifier: pid) else { throw HelperError("Pointer target unavailable", code: "target_gone") }
                heldPointer.hold(PointerPress(window: inputWindow, application: app, button: action.button ?? "left", location: location, mode: mode))
            }
            if action.kind == "up" { heldPointer.targetDestroyed() }
        case "type":
            guard let text = action.text, text.utf16.count <= 4096 else { throw HelperError("Text exceeds limit", code: "bounds") }
            let typing = ValidatedTextInput(destination: destination, replaceSelection: { element, value in
                // Simulator's macOS AX destination is not the UIKit text field.
                if bundle == "com.apple.iphonesimulator" { return false }
                self.measurementInputMark?()
                let success = try replaceAXSelection(element, text: value)
                if success { self.dispatched = true; self.deliveryConfirmed = true }
                return success
            }, postCharacter: { character in
                let units = Array(String(character).utf16)
                let key = usKeys[character]
                // Simulator follows Shift's own key events, not just the flag on the character.
                @MainActor func shift(_ down: Bool) throws {
                    guard key?.shift == true, let event = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: down) else { return }
                    event.type = .flagsChanged
                    event.flags = down ? .maskShift : []
                    try post(event)
                }
                try shift(true)
                defer { try? shift(false) }
                for down in [true, false] {
                    // A process-posted key must retain the selected foreign window number,
                    // just like pointer events. A global CG key follows Simulator's key window.
                    let event = try windowKeyEvent(down ? .keyDown : .keyUp,
                        windowId: inputWindow.windowID, character: String(character),
                        keyCode: key?.code ?? 0, modifiers: key?.shift == true ? [.shift] : [],
                        timestamp: self.runtime.uptime())
                    if key?.shift == true { event.flags = .maskShift }
                    units.withUnsafeBufferPointer { buffer in
                        if let base = buffer.baseAddress { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base) }
                    }
                    try post(event)
                }
            }, clock: runtime.nanos)
            // The event boundary also rechecks key-down/key-up and modifier events so a
            // destination switch during a character cannot send the remainder to a password.
            try typing.type(text, secureAllowed: secureInputAllowed)
        case "paste":
            guard let text = action.text, text.utf16.count <= 4096 else { throw HelperError("Text exceeds limit", code: "bounds") }
            let field = try destination(); try field.requireConsent(secureInputAllowed)
            if try replaceAXSelection(field.element, text: text) { dispatched = true; deliveryConfirmed = true; return }
            guard mode == "foreground" else { throw HelperError("Destination does not support background paste; use text.type or ui.act setValue", code: "not_supported") }
            try await clipboardPaste(text) {
                for down in [true, false] {
                    let event = try windowKeyEvent(down ? .keyDown : .keyUp, windowId: inputWindow.windowID, character: "v", keyCode: 9, modifiers: [.command], timestamp: self.runtime.uptime())
                    event.flags = .maskCommand; try post(event)
                }
            }
        case "key":
            guard let code = action.keyCode, code <= 127, let modifiers = action.modifiers, modifiers.count <= 4 else { throw HelperError("Invalid key", code: "bounds") }
            if mode == "background", !humanDeviceInput {
                let field = try destination()
                if try performAXKey(field.element, code: code, modifiers: modifiers, beforeDispatch: { self.measurementInputMark?() }) {
                    dispatched = true; deliveryConfirmed = true; return
                }
                try requireProcessKeyboardDestination(inputWindow, resolver: resolver)
            }
            var flags = CGEventFlags()
            for modifier in modifiers {
                switch modifier {
                case "command", "meta", "super": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "option", "alt": flags.insert(.maskAlternate)
                case "control": flags.insert(.maskControl)
                default: throw HelperError("Unsupported modifier", code: "modifier_unsupported")
                }
            }
            for down in [true, false] {
                let event = try windowKeyEvent(down ? .keyDown : .keyUp, windowId: inputWindow.windowID,
                    character: "", keyCode: code, modifiers: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)), timestamp: runtime.uptime())
                event.flags = flags; try post(event)
            }
        case "scroll":
            guard let dx = action.deltaX, let dy = action.deltaY, abs(Int(dx)) <= 1000, abs(Int(dy)) <= 1000 else { throw HelperError("Invalid scroll", code: "bounds") }
            if dx != 0 || dy != 0 {
                let name = abs(Int(dx)) > abs(Int(dy)) ? (dx > 0 ? "AXScrollRightByPage" : "AXScrollLeftByPage") : (dy > 0 ? "AXScrollUpByPage" : "AXScrollDownByPage")
                if !humanDeviceInput, try performTargetedAXAction(inputWindow, at: location, names: [name], beforeDispatch: { self.dispatched = true; self.measurementInputMark?() }) { deliveryConfirmed = true; return }
            }
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
