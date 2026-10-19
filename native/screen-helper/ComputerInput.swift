import AppKit
import ApplicationServices
import CoreGraphics

/// Posts synthetic events straight to one process. The person's cursor, keyboard focus and
/// frontmost app are never touched, so the app can sit behind other windows or on another Space.
/// Each call posts events immediately; pacing and stop checks belong to the caller.
@MainActor struct CUPoster {
    let pid: pid_t
    private let source = CGEventSource(stateID: .privateState)

    init(pid: pid_t) { self.pid = pid }

    /// One key transition. `text` overrides the characters the event carries.
    func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags = [], text: String? = nil, autorepeat: Bool = false) {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        event.flags = flags
        if let text, !text.isEmpty {
            let units = Array(text.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        }
        if autorepeat { event.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        event.postToPid(pid)
    }

    /// A key press and release.
    func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) {
        keyEvent(code, down: true, flags: flags, text: text)
        keyEvent(code, down: false, flags: flags, text: text)
    }

    func chord(_ chord: CUChord) { key(chord.code, flags: chord.flags, text: chord.text) }

    /// Types a run of characters in one key event, as a keyboard with an input method would.
    func typeChunk(_ text: String) { key(cuNeutralKeyCode, text: text) }

    /// Types one character on the key that types it on this layout, with its Shift or Option.
    func typeCharacter(_ character: Character, layout: CUKeyLayout) {
        if let stroke = layout.stroke(for: character) { key(stroke.code, flags: stroke.flags, text: String(character)) }
        else { key(cuNeutralKeyCode, text: String(character)) }
    }

    /// One mouse event addressed to one window. Reaches visible windows even when another app
    /// is in front; windows on another Space ignore it, so callers prefer accessibility actions.
    func mouse(_ step: CUMouseEvent, window: CGWindowID?, flags: CGEventFlags = []) {
        let type: CGEventType
        switch (step.kind, step.button) {
        case (.move, _): type = .mouseMoved
        case (.down, .left): type = .leftMouseDown
        case (.up, .left): type = .leftMouseUp
        case (.drag, .left): type = .leftMouseDragged
        case (.down, .right): type = .rightMouseDown
        case (.up, .right): type = .rightMouseUp
        case (.drag, .right): type = .rightMouseDragged
        case (.down, .middle): type = .otherMouseDown
        case (.up, .middle): type = .otherMouseUp
        case (.drag, .middle): type = .otherMouseDragged
        }
        let button: CGMouseButton = step.button == .right ? .right : step.button == .middle ? .center : .left
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: step.point, mouseButton: button) else { return }
        event.flags = flags
        if step.kind != .move { event.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, step.clickState))) }
        if let window {
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
        }
        event.postToPid(pid)
    }

    func scroll(at point: CGPoint, window: CGWindowID?, delta: CUWheelDelta) {
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: delta.dy, wheel2: delta.dx, wheel3: 0) else { return }
        event.location = point
        if let window {
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
        }
        event.postToPid(pid)
    }
}

/// Waits until the app stops reporting UI changes: at least `minimumMs`, then `quietMs`
/// without an accessibility notification, never longer than `maximumMs`.
@MainActor final class CUSettler {
    private var lastChange = DispatchTime.now().uptimeNanoseconds
    private var observer: AXObserver?
    private static let notifications = [
        "AXValueChanged", "AXUIElementDestroyed", "AXCreated", "AXFocusedUIElementChanged", "AXLayoutChanged",
        "AXTitleChanged", "AXSelectedChildrenChanged", "AXSelectedRowsChanged", "AXWindowCreated", "AXMenuOpened",
        "AXMenuClosed", "AXRowCountChanged", "AXSelectedTextChanged", "AXFocusedWindowChanged", "AXSheetCreated",
        "AXLoadComplete", "AXExpandedChanged",
    ]

    init(pid: pid_t) {
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            let settler = Unmanaged<CUSettler>.fromOpaque(refcon).takeUnretainedValue()
            MainActor.assumeIsolated { settler.lastChange = DispatchTime.now().uptimeNanoseconds }
        }
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return }
        observer = created
        let application = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for name in Self.notifications { AXObserverAddNotification(created, application, name as CFString, refcon) }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
    }

    func markChanged() { lastChange = DispatchTime.now().uptimeNanoseconds }

    func settle(minimumMs: UInt64 = 120, quietMs: UInt64 = 250, maximumMs: UInt64 = 3_000) async {
        let started = DispatchTime.now().uptimeNanoseconds
        while true {
            try? await Task.sleep(nanoseconds: 30_000_000)
            let now = DispatchTime.now().uptimeNanoseconds
            let elapsed = (now - started) / 1_000_000
            if elapsed >= maximumMs { return }
            if elapsed >= minimumMs && (now - lastChange) / 1_000_000 >= quietMs { return }
        }
    }

    func close() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
    }
}
