import AppKit
import ApplicationServices
import ScreenCaptureKit

extension Capture {
    /// Cleanup addresses the window that received down, even if another window now covers it.
    /// A failed query is not proof of destruction, and a failed post retains the held target.
    func releasePointer() throws {
        guard let press = heldPointer.target else { return }
        guard let app = press.window.owningApplication else { throw HelperError("Cannot verify original application", code: "target_gone") }
        guard !press.application.isTerminated,
              let running = NSRunningApplication(processIdentifier: app.processID), !running.isTerminated,
              running.bundleIdentifier == app.bundleIdentifier,
              running.launchDate == press.application.launchDate else { heldPointer.targetDestroyed(); return }
        // Permission denial can hide window rows; it is not evidence of destruction.
        try InputPermission.require(runtime.inputAllowed())
        guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, press.window.windowID) as? [[String: Any]] else {
            throw HelperError("Cannot verify original pointer target", code: "target_gone")
        }
        guard let row = rows.first else {
            try InputPermission.require(runtime.inputAllowed())
            heldPointer.targetDestroyed(); return
        }
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processID else {
            heldPointer.targetDestroyed(); return
        }
        let bounds = try currentWindowBounds(press.window)
        try heldPointer.release { original in
            let x = min(max(original.location.x - bounds.minX, 0), bounds.width - 1)
            let y = min(max(original.location.y - bounds.minY, 0), bounds.height - 1)
            let point = CGPoint(x: x, y: CGDisplayBounds(CGMainDisplayID()).height - y)
            guard let event = NSEvent.mouseEvent(with: original.button == "right" ? .rightMouseUp : .leftMouseUp,
                location: point, modifierFlags: [], timestamp: runtime.uptime(), windowNumber: Int(original.window.windowID),
                context: nil, eventNumber: 0, clickCount: 1, pressure: 0)?.cgEvent else { throw HelperError("Cannot create pointer release") }
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(original.window.windowID))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(original.window.windowID))
            try deliverInput(event, mode: original.mode, pid: app.processID, permission: runtime.inputAllowed) { event, destination in
                switch destination {
                case .foreground:
                    // Release the original HID press without moving the person's cursor.
                    guard let current = CGEvent(source: nil)?.location else { throw HelperError("Cannot read cursor for release", code: "internal") }
                    event.location = current; event.post(tap: .cghidEventTap)
                case let .process(pid): event.postToPid(pid)
                }
            }
        }
    }
}
