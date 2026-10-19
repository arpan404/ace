import AppKit
import ApplicationServices
import CoreGraphics

/// Posts synthetic events straight to one process. The person's cursor, keyboard focus and
/// frontmost app are never touched, so the app can sit behind other windows or on another Space.
@MainActor struct CUPoster {
    let pid: pid_t
    private let source = CGEventSource(stateID: .privateState)

    init(pid: pid_t) { self.pid = pid }

    func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            if let text, !text.isEmpty {
                let units = Array(text.utf16)
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            }
            event.postToPid(pid)
            usleep(2_000)
        }
    }

    func chord(_ chord: CUChord) { key(chord.code, flags: chord.flags, text: chord.text) }

    func type(_ text: String) {
        for step in cuTypingSteps(text) {
            switch step {
            case .key(let code): key(code, text: code == 36 ? "\r" : "\t")
            case .character(let character):
                if let (code, shifted) = cuCharacterKeys[character] { key(code, flags: shifted ? .maskShift : [], text: String(character)) }
                else { key(0, text: String(character)) }
            }
            usleep(4_000)
        }
    }

    /// A click addressed to one window. Reaches visible windows even when another app is in
    /// front; windows on another Space ignore it, so callers prefer accessibility actions.
    func click(at point: CGPoint, window: CGWindowID?, button: CGMouseButton = .left, count: Int = 1) {
        let types: (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        for clickIndex in 1...max(1, min(count, 3)) {
            for type in [types.0, types.1] {
                guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { continue }
                event.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
                if let window {
                    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
                    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
                }
                event.postToPid(pid)
                usleep(15_000)
            }
        }
    }

    func drag(from start: CGPoint, to end: CGPoint, window: CGWindowID?) {
        func post(_ type: CGEventType, _ point: CGPoint) {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
            if let window {
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
            }
            event.postToPid(pid)
        }
        post(.leftMouseDown, start)
        for step in 1...12 {
            let fraction = Double(step) / 12
            post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction))
            usleep(12_000)
        }
        post(.leftMouseUp, end)
    }

    func scroll(at point: CGPoint, window: CGWindowID?, dx: Int32, dy: Int32) {
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
        event.location = point
        if let window { event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window)) }
        event.postToPid(pid)
    }
}
