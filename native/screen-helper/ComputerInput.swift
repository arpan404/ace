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

    /// One mouse event for one window. On screen the window server routes it to the window
    /// under the point; with a `target` (a window on another Space or behind a full-screen
    /// app, where nothing of the app is under the point) the event names the window itself.
    func mouse(_ step: CUMouseEvent, window: CGWindowID?, target: CUPointerTarget? = nil, flags: CGEventFlags = []) {
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
        address(event, window: target?.window ?? window)
        if let target { cuAddressToWindow(event, target: target, at: step.point) }
        event.postToPid(pid)
    }

    func scroll(at point: CGPoint, window: CGWindowID?, target: CUPointerTarget? = nil, delta: CUWheelDelta) {
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: delta.dy, wheel2: delta.dx, wheel3: 0) else { return }
        event.location = point
        address(event, window: target?.window ?? window)
        if let target { cuAddressToWindow(event, target: target, at: point) }
        event.postToPid(pid)
    }

    private func address(_ event: CGEvent, window: CGWindowID?) {
        guard let window else { return }
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    }
}

/// The event field AppKit reads an event's window number from (`NSEvent.windowNumber`). The
/// window server fills it, and the window location, when it routes an event by position.
private let cuEventWindowNumberField = CGEventField(rawValue: 51)

/// Names the window an event is for and sets its window-local location, so AppKit delivers it
/// to that window at that point although no window is under the point on this screen.
/// The window location setter is SkyLight's (re-exported by CoreGraphics), resolved once.
func cuAddressToWindow(_ event: CGEvent, target: CUPointerTarget, at point: CGPoint) {
    if let field = cuEventWindowNumberField { event.setIntegerValueField(field, value: Int64(target.window)) }
    CUWindowLocationSetter.set?(event, cuWindowPoint(point, in: target))
}

private enum CUWindowLocationSetter {
    typealias Function = @convention(c) (CGEvent, CGPoint) -> Void
    static let set: Function? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation").map { unsafeBitCast($0, to: Function.self) }
}
