import AppKit
import ApplicationServices

/// Runs model actions against one app session. Each returns a one-line account of what it
/// did, so the model knows which path was taken. The actions themselves live in extensions
/// by kind: pointer, scrolling, keyboard, elements, menus, windows and conditions.
@MainActor struct CUActor {
    let session: CUAppSession
    /// Shows the person where the agent acts, for windows they can see.
    var indicate: (CGPoint) -> Void = { _ in }
    /// Throws when the request must stop now (cancelled, stopped by the person, the person is
    /// using the app). Called between sub-steps and inside every long loop.
    var checkpoint: () throws -> Void = {}
    var poster: CUPoster { CUPoster(pid: session.pid) }
    private(set) var skipped = false

    mutating func run(_ action: CUObject) async throws -> String {
        skipped = false
        guard let kind = action.string("type") else { throw CUError("bad_action", "Each action needs a type.") }
        session.prepareAction(action)
        try await waitForHuman()
        session.refreshWindow()
        if let condition = try cuCondition(action["when"]) {
            guard cuConditionHolds(condition, nodes: session.refreshNodes()) else {
                skipped = true
                return "skipped \(kind): condition not met"
            }
        }
        if session.window?.onScreen == true, !cuScreenLocked(), let target = session.actionTarget, let point = visibleCenter(target) {
            indicate(point)
        }
        let copies = cuStepCopies(kind: kind, action: action)
        let clipboard = NSPasteboard.general.changeCount
        let line = try await dispatch(kind, action)
        return copies ? line + (await copiedNote(since: clipboard)) : line
    }

    private func dispatch(_ kind: String, _ action: CUObject) async throws -> String {
        // Keyboard input and menus act on the app's key window; make ours key first.
        // Direct value, selection and focus setters name their AX element. They do not
        // use the app's first responder and need no background key-window activation.
        if ["type", "key", "paste", "menu"].contains(kind) { session.makeKey() }
        switch kind {
        case "click": return try await click(action)
        case "move": return try await move(action)
        case "drag": return try await drag(action)
        case "type": return try await typeText(action)
        case "paste": return try await paste(action)
        case "key": return try await key(action)
        case "set_value": return try setValue(action)
        case "select_text": return try selectText(action)
        case "focus": return try focus(element(action))
        case "action": return try await secondary(action)
        case "scroll": return try await scroll(action)
        case "scroll_to": return try await scrollTo(action)
        case "menu": return try await menu(action.strings("path"))
        case "window": return try await windowOp(action)
        case "wait": return try await wait(action)
        case "wait_for": return try await waitFor(action)
        case "activate": return try await activate()
        default: throw CUError("bad_action", "Unknown action type \"\(kind)\".")
        }
    }

    // MARK: Targets

    /// Resolve brief typing conflicts inside the batch, before any side effect. A partially
    /// executed action is never retried; its later checkpoints still stop immediately.
    private func waitForHuman() async throws {
        let until = cuNow() + 3_000_000_000
        while true {
            do { try checkpoint(); return }
            catch let fault as CUError where fault.code == "person_active" && cuNow() < until {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    func element(_ action: CUObject) throws -> AXUIElement {
        guard let id = action.int("id") else { throw CUError("bad_action", "This action needs an element id.") }
        return try element(id: id)
    }

    func element(id: Int) throws -> AXUIElement {
        guard let element = session.registry.element(id) else {
            throw CUError("stale_element", "Element \(id) is no longer in \(session.name). Observe again and use a current id.")
        }
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &role) == .invalidUIElement {
            if cuSessionStatus() == .locked { throw cuLockedControlsError }
            throw CUError("stale_element", "Element \(id) went away (the UI changed). Observe again and use a current id.")
        }
        return element
    }

    func label(_ element: AXUIElement) -> String {
        let id = session.registry.existingId(for: element).map { "\($0) " } ?? ""
        let role = cuAttribute(element, "AXRoleDescription") as? String ?? cuRole(element)
        let name = cuClip((cuAttribute(element, "AXTitle") as? String) ?? (cuAttribute(element, "AXDescription") as? String) ?? cuValueText(cuAttribute(element, "AXValue")), 60)
        return "\(id)\(role)\(name.map { " \"\($0)\"" } ?? "")"
    }

    /// The centre of the part of an element inside its window, where a posted click lands.
    func visibleCenter(_ element: AXUIElement) -> CGPoint? {
        guard let frame = cuFrame(of: element), frame.width > 0, frame.height > 0 else { return nil }
        let visible = session.window.map { frame.intersection($0.frame) } ?? frame
        let area = visible.isNull || visible.width < 1 || visible.height < 1 ? frame : visible
        return CGPoint(x: area.midX, y: area.midY)
    }

    func parent(_ element: AXUIElement) -> AXUIElement? { cuAttribute(element, "AXParent").map { $0 as! AXUIElement } }

    func focusedElement() -> AXUIElement? {
        if session.preserveHumanFocus { return session.agentInputFocus }
        if cuSessionStatus() == .locked, let target = session.agentInputFocus { return target }
        return cuElementAttribute(session.element, "AXFocusedUIElement")
    }

    func textTarget() -> CUTextTarget? { focusedElement().flatMap(CUTextTarget.init) }

    func postedInputCheckpoint() throws {
        try checkpoint()
        try cuRequirePostedInput(cuSessionStatus())
    }

    func requireAppResponder() throws {
        if session.preserveHumanFocus {
            throw CUError("window_focus_required", "This command would use the person's focus in \(session.name). Use element ids, set_value, paste, or an element action instead.")
        }
    }

    /// Performs an AX action. A press that opens a modal often reports "cannot complete" after
    /// it took effect (the app was busy running the modal); that counts as done when a new
    /// window, sheet or focus shows up, so the model does not press twice.
    /// Returns a note to append to the step's line ("" normally).
    @discardableResult
    func perform(_ element: AXUIElement, _ name: String) async throws -> String {
        let result = AXUIElementPerformAction(element, name as CFString)
        if result == .success { session.settler.markChanged(); return "" }
        if result == .invalidUIElement { throw CUError("stale_element", "The element went away. Observe again.") }
        if result == .cannotComplete {
            for _ in 0..<6 {
                if appearsChanged(after: element) {
                    session.settler.markChanged()
                    return " (\(session.name) was busy replying; a new window, sheet or focus appeared)"
                }
                try await pause(ms: 50)
            }
            throw CUError("app_busy", "\(session.name) did not answer the \(name.replacingOccurrences(of: "AX", with: "")) (it may be busy or showing a modal dialog). It may still have taken effect: observe before retrying.")
        }
        throw CUError("action_failed", "\(session.name) refused \(name.replacingOccurrences(of: "AX", with: "")) on \(label(element)) (AX error \(result.rawValue)).")
    }

    private func appearsChanged(after element: AXUIElement) -> Bool {
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &role) == .invalidUIElement { return true }
        guard let focused = cuAttribute(session.element, "AXFocusedWindow") else { return false }
        let window = focused as! AXUIElement
        if let current = session.window?.element, !CFEqual(current, window) { return true }
        if ["AXDialog", "AXSystemDialog"].contains(cuAttribute(window, "AXSubrole") as? String ?? "") { return true }
        return (cuAttribute(window, "AXChildren") as? [AXUIElement] ?? []).contains { cuRole($0) == "AXSheet" }
    }

    /// Sleeps in slices of at most 50 ms, checking between them whether to stop.
    func pause(ms: Int) async throws {
        var left = max(0, ms)
        try checkpoint()
        while left > 0 {
            let slice = min(left, 50)
            try? await Task.sleep(nanoseconds: UInt64(slice) * 1_000_000)
            left -= slice
            try checkpoint()
        }
    }

    // MARK: Simple actions

    func focus(_ element: AXUIElement) throws -> String {
        if cuSessionStatus() == .locked {
            session.rememberFocus(element)
            return "selected \(label(element)) for accessibility input while locked"
        }
        if session.preserveHumanFocus {
            session.rememberFocus(element)
            return "selected \(label(element)) for agent input, preserving the person's window focus"
        }
        if let window = session.window { AXUIElementSetAttributeValue(window.element, "AXMain" as CFString, kCFBooleanTrue) }
        let result = AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue)
        guard result == .success else { throw CUError("action_failed", "\(session.name) would not focus \(label(element)). Try clicking it instead.") }
        session.settler.markChanged()
        return "focused \(label(element))"
    }

    private func wait(_ action: CUObject) async throws -> String {
        let ms = min(max(action.int("ms") ?? 500, 0), 10_000)
        try await pause(ms: ms)
        return "waited \(ms) ms"
    }

    /// Last resort: bring the app and its window to the front. This takes focus from the person.
    private func activate() async throws -> String {
        guard !cuScreenLocked() else {
            throw CUError("screen_locked", "The Mac is locked. Use background accessibility actions; bringing an app to the front requires the person to unlock it.")
        }
        session.app.unhide()
        if let window = session.window {
            AXUIElementSetAttributeValue(window.element, "AXMinimized" as CFString, kCFBooleanFalse)
            AXUIElementSetAttributeValue(window.element, "AXMain" as CFString, kCFBooleanTrue)
            AXUIElementPerformAction(window.element, "AXRaise" as CFString)
        }
        _ = session.app.activate(options: [])
        try await pause(ms: 300)
        session.settler.markChanged()
        return session.app.isActive ? "brought \(session.name) to the front" : "asked \(session.name) to come to the front; macOS may not have switched to it yet"
    }

    // MARK: Copy results

    /// Appends what the step copied, read only when the clipboard changed during the step.
    private func copiedNote(since changeCount: Int) async -> String {
        let board = NSPasteboard.general
        for _ in 0..<8 where board.changeCount == changeCount { try? await Task.sleep(nanoseconds: 40_000_000) }
        guard board.changeCount != changeCount, let text = board.string(forType: .string), !text.isEmpty else { return "" }
        return ". " + cuCopiedLine(text)
    }
}

/// Whether a step copies to the clipboard: ⌘C or ⌘X, or a menu path ending in Copy or Cut.
@MainActor func cuStepCopies(kind: String, action: CUObject) -> Bool {
    switch kind {
    case "key":
        guard let chord = try? cuParseChord(action.string("key") ?? "") else { return false }
        return cuTextCommand(chord) == .copy || cuTextCommand(chord) == .cut
    case "menu": return ["copy", "cut"].contains(cuMenuTitleKey(action.strings("path").last ?? ""))
    default: return false
    }
}

/// `Copied: "<first 500 characters>"`.
func cuCopiedLine(_ text: String) -> String {
    let clipped = text.count > 500 ? String(text.prefix(500)) + "…" : text
    return "Copied: \"\(clipped)\""
}
