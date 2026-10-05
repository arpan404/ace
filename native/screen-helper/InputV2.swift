import ApplicationServices
import AppKit

extension Capture {
    func injectV2(_ input: Input) async throws {
        guard target?.kind == "window" || target?.kind == "app" else { throw HelperError("Display is view-only", code: "not_supported") }
        // V2 coordinates are target points. The legacy injector scales pixels to global points.
        var bounds = frame
        var selectedWindow: UInt32?
        if target?.kind == "app", input.kind.hasPrefix("pointer.") || input.kind == "scroll" {
            guard let bundle = target?.bundleId, let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first,
                  let focused = axAttribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { throw HelperError("Approved app has no focused input window", code: "not_supported") }
            bounds = axBounds(focused as! AXUIElement).rect
            let windows = try await content().windows.filter { $0.owningApplication?.processID == app.processIdentifier && abs($0.frame.minX - bounds.minX) < 1 && abs($0.frame.minY - bounds.minY) < 1 && abs($0.frame.width - bounds.width) < 1 && abs($0.frame.height - bounds.height) < 1 }
            guard windows.count == 1 else { throw HelperError("Ambiguous focused window", code: "bounds") }
            selectedWindow = windows.first?.windowID
        }
        if input.kind.hasPrefix("pointer."), target?.kind == "app" {
            guard let x = input.x, let y = input.y, x >= 0, y >= 0, x < bounds.width, y < bounds.height else { throw HelperError("Pointer outside target window", code: "bounds") }
        }
        let sx = Double(width) / frame.width, sy = Double(height) / frame.height
        let x = input.x.map { ($0 + bounds.minX - frame.minX) * sx }, y = input.y.map { ($0 + bounds.minY - frame.minY) * sy }
        var action = Action(kind: "")
        action.x = target?.kind == "window" ? input.x : x; action.y = target?.kind == "window" ? input.y : y;
        if target?.kind == "window" { action.coordinates = .windowPoints }
        // Simulator accepts events explicitly addressed to its window even while backgrounded.
        // AX focus discovery is expensive and does not affect this targeted pointer routing.
        if target?.kind == "window", target?.bundleId == "com.apple.iphonesimulator", input.kind.hasPrefix("pointer.") { action.focusFirst = false }
        action.windowId = selectedWindow; action.button = input.button ?? "left"
        switch input.kind {
        case "pointer.click": action.kind = "click"
        case "pointer.move": action.kind = pointerAction == nil ? "move" : "drag"
        case "pointer.down": action.kind = "down"
        case "pointer.up": action.kind = "up"
        case "pointer.cancel": await releasePointer(); return
        case "pointer.drag":
            guard let endX = input.toX, let endY = input.toY, endX.isFinite, endY.isFinite, endX >= 0, endY >= 0, (target?.kind == "window" || (endX < bounds.width && endY < bounds.height)) else { throw HelperError("Drag endpoint outside target", code: "bounds") }
            let duration = input.durationMs ?? 0
            guard duration >= 0, duration <= 10_000, input.durationMs == nil || duration > 0 else { throw HelperError("Invalid gesture duration", code: "bounds") }
            let gestureTarget = target
            let startX = action.x ?? 0, startY = action.y ?? 0
            let destinationX = target?.kind == "window" ? endX : (endX + bounds.minX - frame.minX) * sx
            let destinationY = target?.kind == "window" ? endY : (endY + bounds.minY - frame.minY) * sy
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
                if target == gestureTarget { try? await inject(release) }
                throw error
            }
            return
        case "text.type": action.kind = "type"; action.text = input.text
        case "scroll": action.kind = "scroll"; if target?.kind != "window" { action.x = x ?? (bounds.midX - frame.minX) * sx; action.y = y ?? (bounds.midY - frame.minY) * sy }; action.deltaX = input.dx; action.deltaY = input.dy
        case "key.press":
            guard let key = input.key else { throw HelperError("Key required", code: "bounds") }
            let codes: [String: UInt16] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"escape":53,"delete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"left":123,"right":124,"down":125,"up":126]
            guard let code = codes[key.lowercased()] else { throw HelperError("Unsupported key; use Unicode text.type for text", code: "not_supported") }
            action.kind = "key"; action.keyCode = code; action.modifiers = input.modifiers ?? []
        default: throw HelperError("Unsupported input", code: "not_supported")
        }
        try await inject(action)
    }
    func semanticFallback(_ bounds: UIBounds, action: String, value: String?) async throws {
        var current = frame
        if target?.kind == "window" {
            guard let window = try await content().windows.first(where: { $0.windowID == target?.windowId && $0.owningApplication?.bundleIdentifier == target?.bundleId }) else { throw HelperError("Target window is gone", code: "target_gone") }
            current = try currentWindowBounds(window)
        }
        guard bounds.rect.intersects(current), current.contains(CGPoint(x: bounds.rect.midX, y: bounds.rect.midY)) else { throw HelperError("Element centre is outside approved target", code: "bounds") }
        let points = target?.kind == "window"
        let x = (bounds.rect.midX - current.minX) * (points ? 1 : Double(width) / current.width)
        let y = (bounds.rect.midY - current.minY) * (points ? 1 : Double(height) / current.height)
        var pointer = Action(kind: "click"); pointer.x = x; pointer.y = y; pointer.button = "left"
        if points { pointer.coordinates = .windowPoints }
        if action == "scroll" { pointer.kind = "scroll"; pointer.deltaX = 0; pointer.deltaY = value == "up" ? 100 : -100 }
        try await inject(pointer)
        if action == "setValue" {
            var select = Action(kind: "key"); select.keyCode = 0; select.modifiers = ["command"]; try await inject(select)
            var text = Action(kind: "type"); text.text = value ?? ""; try await inject(text)
        }
    }
}
