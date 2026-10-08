import ApplicationServices
import AppKit

extension Capture {
    /// Human device actions authorize activation of their selected Simulator window.
    /// Agent input retains the background path and never comes through this entry point.
    func injectHumanDevice(_ input: Input) async throws {
        if input.kind == "pointer.cancel" { try releasePointer(); return }
        guard let window = captureWindow, let pid = window.owningApplication?.processID else {
            throw HelperError("Simulator input window disappeared", code: "target_gone")
        }
        mode = "foreground"
        try await foregroundWindow(window)
        if ["text.type", "key.press", "text.paste"].contains(input.kind) {
            try requireFocusedWindow(window, candidates: try await content().windows.filter { $0.owningApplication?.processID == pid })
        }
        try await injectV2(input)
    }
    func injectV2(_ input: Input) async throws {
        guard target?.kind == "window" || target?.kind == "app" else { throw HelperError("Display is view-only", code: "not_supported") }
        if input.kind == "pointer.cancel" { try releasePointer(); return }
        // V2 coordinates are target points. The legacy injector scales pixels to global points.
        var bounds = frame
        var selectedWindow: UInt32?
        if target?.kind == "app", input.kind.hasPrefix("pointer.") || input.kind == "scroll" {
            guard let bundle = target?.bundleId, let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first,
                  let focused = axAttribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { throw HelperError("Approved app has no focused input window", code: "not_supported") }
            let id = try resolver.identity(focused as! AXUIElement, pid: app.processIdentifier)
            guard let window = try await content().windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == app.processIdentifier }) else { throw HelperError("Focused app window is gone", code: "target_gone") }
            bounds = try currentWindowBounds(window)
            selectedWindow = id
        }
        if input.kind.hasPrefix("pointer."), target?.kind == "app" {
            guard let x = input.x, let y = input.y, x >= 0, y >= 0, x < bounds.width, y < bounds.height else { throw HelperError("Pointer outside target window", code: "bounds") }
        }
        var action = Action(kind: "")
        action.x = input.x; action.y = input.y
        action.coordinates = .windowPoints
        action.windowId = selectedWindow; action.button = input.button ?? "left"
        switch input.kind {
        case "pointer.click": action.kind = "click"
        case "pointer.move": action.kind = pointerAction == nil ? "move" : "drag"
        case "pointer.down": action.kind = "down"
        case "pointer.up": action.kind = "up"
        case "pointer.drag":
            guard let endX = input.toX, let endY = input.toY, endX.isFinite, endY.isFinite, endX >= 0, endY >= 0, (target?.kind == "window" || (endX < bounds.width && endY < bounds.height)) else { throw HelperError("Drag endpoint outside target", code: "bounds") }
            let duration = input.durationMs ?? 0
            guard duration >= 0, duration <= 10_000, input.durationMs == nil || duration > 0 else { throw HelperError("Invalid gesture duration", code: "bounds") }
            let gestureTarget = target
            let startX = action.x ?? 0, startY = action.y ?? 0
            let destinationX = endX
            let destinationY = endY
            // Check both endpoints before pressing. inject rechecks the live
            // target, permissions and bounds for every step of the gesture.
            if let gestureTarget, gestureTarget.kind == "window" {
                guard let window = try await content().windows.first(where: { $0.windowID == gestureTarget.windowId && $0.owningApplication?.bundleIdentifier == gestureTarget.bundleId }) else { throw HelperError("Gesture target is gone", code: "target_gone") }
                let current = try currentWindowBounds(window)
                guard endX < current.width, endY < current.height else { throw HelperError("Drag endpoint outside target", code: "bounds") }
            }
            try Task.checkCancellation()
            action.kind = "down"; try await inject(action)
            var release = action; release.kind = "up"
            do {
                let steps = duration == 0 ? 1 : min(120, max(1, (duration + 15) / 16))
                for step in 1...steps {
                    if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration) * 1_000_000 / UInt64(steps)) }
                    try Task.checkCancellation()
                    guard target == gestureTarget else { throw HelperError("Capture target changed during gesture", code: "target_gone") }
                    let fraction = Double(step) / Double(steps)
                    action.kind = "drag"; action.x = startX + (destinationX - startX) * fraction; action.y = startY + (destinationY - startY) * fraction
                    try await inject(action)
                    release.x = action.x; release.y = action.y
                }
                guard target == gestureTarget else { throw HelperError("Capture target changed during gesture", code: "target_gone") }
                try await inject(release)
            } catch {
                // A cancelled Task's flag remains set; release itself has no
                // cancellation check and still uses the approved target path.
                if target == gestureTarget { try? releasePointer() }
                throw error
            }
            return
        case "text.paste": action.kind = "paste"; action.text = input.text
        case "text.type": action.kind = "type"; action.text = input.text
        case "scroll": action.kind = "scroll"; action.deltaX = input.dx; action.deltaY = input.dy
        case "key.press":
            guard let key = input.key else { throw HelperError("Key required", code: "bounds") }
            let parsedKey = try namedKey(key, modifiers: input.modifiers ?? [])
            action.kind = "key"; action.keyCode = parsedKey.code; action.modifiers = parsedKey.modifiers
        default: throw HelperError("Unsupported input", code: "not_supported")
        }
        try await inject(action)
    }
    func semanticFallback(_ bounds: UIBounds, action: String, value: String?) async throws {
        var current = frame
        var inputWindowId = target?.windowId
        if target?.kind == "window" {
            guard let window = try await content().windows.first(where: { $0.windowID == target?.windowId && $0.owningApplication?.bundleIdentifier == target?.bundleId }) else { throw HelperError("Target window is gone", code: "target_gone") }
            current = try currentWindowBounds(window)
        } else if let bundle = target?.bundleId {
            let window = try appInputWindow(try await content().windows.filter { $0.owningApplication?.bundleIdentifier == bundle && $0.windowLayer == 0 })
            current = try currentWindowBounds(window)
            inputWindowId = window.windowID
        }
        guard bounds.rect.intersects(current), current.contains(CGPoint(x: bounds.rect.midX, y: bounds.rect.midY)) else { throw HelperError("Element centre is outside approved target", code: "bounds") }
        let x = bounds.rect.midX - current.minX, y = bounds.rect.midY - current.minY
        var pointer = Action(kind: "click"); pointer.x = x; pointer.y = y; pointer.button = "left"
        pointer.coordinates = .windowPoints; pointer.windowId = inputWindowId
        if action == "scroll" { pointer.kind = "scroll"; pointer.deltaX = 0; pointer.deltaY = value == "up" ? 100 : -100 }
        try await inject(pointer)
        if action == "setValue" {
            var select = Action(kind: "key"); select.keyCode = 0; select.modifiers = ["command"]; try await inject(select)
            var text = Action(kind: "type"); text.text = value ?? ""; try await inject(text)
        }
    }
}
