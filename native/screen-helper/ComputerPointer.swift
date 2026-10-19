import AppKit
import ApplicationServices

/// Clicks, hovering and dragging. Plain clicks on named elements go through accessibility;
/// everything a real mouse is needed for is posted to the app's window, made key first so the
/// first click is not swallowed as a mere "bring to front".
extension CUActor {
    func click(_ action: CUObject) async throws -> String {
        guard let button = CUMouseButton(rawValue: action.string("button") ?? "left") else { throw CUError("bad_action", "button is left, right or middle.") }
        let count = max(1, min(action.int("count") ?? 1, 3))
        let modifiers = try cuModifierFlags(action.strings("modifiers"))
        let hold = max(0, min(action.int("hold_ms") ?? 0, 5_000))
        let onScreen = session.window?.onScreen == true
        var target: AXUIElement?
        var point: CGPoint?
        if action.int("id") != nil { target = try element(action) }
        else if let x = action.double("x"), let y = action.double("y") {
            let at = try session.screenPoint(fromPixel: CGPoint(x: x, y: y))
            point = at
            target = session.element(atScreen: at)
        } else { throw CUError("bad_action", "click needs an element id, or x and y from a screenshot.") }

        if onScreen, let shown = point ?? target.flatMap(visibleCenter) { indicate(shown) }
        if let target {
            var facts = CUClickFacts(byId: point == nil, button: button, count: count, modified: !modifiers.isEmpty || hold > 0,
                                     actions: cuActionNames(target), role: cuRole(target), onScreen: onScreen)
            if count == 1, !facts.actions.contains("AXPress"), point == nil || !onScreen {
                facts.selectableRow = selectableRow(target) != nil
                facts.pressableAncestor = pressableAncestor(target) != nil
            }
            if let done = try await clickThroughAccessibility(target, route: cuClickRoute(facts)) { return done }
        }
        guard let at = point ?? target.flatMap(visibleCenter) else {
            throw CUError("not_clickable", "That element has no position to click. Try an action listed on it, a menu path, or the keyboard.")
        }
        guard onScreen else {
            throw CUError("not_clickable", "Nothing there can be pressed through accessibility, and \(session.name)'s window is not on the current screen (another Space, minimized or behind a full-screen app), so a mouse click would not land. Use an element id with an action, a menu path, or keys instead.")
        }
        session.makeKey()
        try await runMouse(cuClickEvents(at: at, button: button, count: count, holdMs: hold), flags: modifiers)
        session.settler.markChanged()
        let kind = (button == .left ? "" : "\(button.rawValue)-") + (count == 2 ? "double-" : count == 3 ? "triple-" : "")
        let extras = (modifiers.isEmpty ? "" : " with \(cuModifierNames(modifiers))") + (hold > 0 ? ", held \(hold) ms" : "")
        return "\(kind)clicked\(extras) at the point\(target.map { " over \(label($0))" } ?? "")"
    }

    /// Runs an accessibility route; nil means post a real click instead.
    private func clickThroughAccessibility(_ target: AXUIElement, route: CUClickRoute) async throws -> String? {
        switch route {
        case .press:
            let note = try await perform(target, "AXPress")
            return "pressed \(label(target))\(note)\(opensMenu(target) ? cuMenuOpenNote : "")"
        case .pressAncestor:
            guard let ancestor = pressableAncestor(target) else { return nil }
            let note = try await perform(ancestor, "AXPress")
            return "pressed \(label(ancestor))\(note)\(opensMenu(ancestor) ? cuMenuOpenNote : "")"
        case .open:
            let note = try await perform(target, "AXOpen")
            return "opened \(label(target))\(note)"
        case .showMenu:
            let note = try await perform(target, "AXShowMenu")
            return "opened the context menu of \(label(target))\(note)\(cuMenuOpenNote)"
        case .focus: return try focus(target)
        case .selectRow:
            guard let row = selectableRow(target) else { return nil }
            let result = AXUIElementSetAttributeValue(row, "AXSelected" as CFString, kCFBooleanTrue)
            guard result == .success else {
                if session.window?.onScreen == true { return nil }
                throw CUError("action_failed", "\(session.name) would not select \(label(row)) (AX error \(result.rawValue)). Try the keyboard (Up/Down) instead.")
            }
            session.settler.markChanged()
            return "selected \(label(row))"
        case .selectWord: return selectTextUnit(target, line: false)
        case .selectLine: return selectTextUnit(target, line: true)
        case .post: return nil
        }
    }

    /// Pop-up buttons and menu buttons open a menu that tracks keys until it closes.
    private func opensMenu(_ element: AXUIElement) -> Bool { ["AXPopUpButton", "AXMenuButton"].contains(cuRole(element)) }

    /// The row or cell a click on its content means to select.
    func selectableRow(_ element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0..<4 {
            guard let item = current else { return nil }
            var settable = DarwinBoolean(false)
            if ["AXRow", "AXOutlineRow", "AXCell"].contains(cuRole(item)),
               AXUIElementIsAttributeSettable(item, "AXSelected" as CFString, &settable) == .success, settable.boolValue { return item }
            current = parent(item)
        }
        return nil
    }

    func pressableAncestor(_ element: AXUIElement) -> AXUIElement? {
        var ancestor = parent(element)
        for _ in 0..<3 {
            guard let current = ancestor else { return nil }
            if cuActionNames(current).contains("AXPress") { return current }
            ancestor = parent(current)
        }
        return nil
    }

    /// Double and triple clicks on text select the word or line at the element's centre.
    private func selectTextUnit(_ element: AXUIElement, line: Bool) -> String? {
        guard let center = visibleCenter(element), let text = cuAttribute(element, "AXValue") as? String else { return nil }
        var point = center
        guard let pointValue = AXValueCreate(.cgPoint, &point) else { return nil }
        var rangeValue: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, "AXRangeForPosition" as CFString, pointValue, &rangeValue) == .success,
              let rangeValue, CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return nil }
        var hit = CFRange()
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &hit) else { return nil }
        var range: CFRange
        if line {
            var lineValue: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(element, "AXLineForIndex" as CFString, hit.location as CFNumber, &lineValue) == .success,
                  let lineNumber = lineValue as? NSNumber else { return nil }
            var lineRange: CFTypeRef?
            guard AXUIElementCopyParameterizedAttributeValue(element, "AXRangeForLine" as CFString, lineNumber, &lineRange) == .success,
                  let lineRange, CFGetTypeID(lineRange) == AXValueGetTypeID() else { return nil }
            range = CFRange()
            guard AXValueGetValue(lineRange as! AXValue, .cfRange, &range) else { return nil }
        } else {
            let word = cuWordRange(in: text, at: hit.location)
            range = CFRange(location: word.location, length: word.length)
        }
        guard let value = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(element, "AXSelectedTextRange" as CFString, value) == .success else { return nil }
        session.settler.markChanged()
        let selected = (text as NSString).substring(with: NSRange(location: range.location, length: min(range.length, (text as NSString).length - range.location)))
        return "selected \(line ? "the line" : "the word") \"\(cuClip(selected, 60) ?? "")\" in \(label(element))"
    }

    /// Posts mouse events in order with their pauses. A pressed button is always released,
    /// even when the step is stopped half way.
    func runMouse(_ events: [CUMouseEvent], flags: CGEventFlags) async throws {
        let window = session.window?.number
        var pressed: CUMouseEvent?
        do {
            for event in events {
                poster.mouse(event, window: window, flags: flags)
                if event.kind == .down { pressed = event } else if event.kind == .up { pressed = nil }
                else if event.kind == .drag, let down = pressed { pressed = CUMouseEvent(kind: .down, button: down.button, point: event.point, clickState: down.clickState, delayMs: 0) }
                if event.delayMs > 0 { try await pause(ms: event.delayMs) }
            }
        } catch {
            if let down = pressed { poster.mouse(CUMouseEvent(kind: .up, button: down.button, point: down.point, clickState: down.clickState, delayMs: 0), window: window, flags: flags) }
            throw error
        }
    }

    // MARK: move

    func move(_ action: CUObject) async throws -> String {
        let point: CGPoint
        if action.int("id") != nil {
            let target = try element(action)
            guard let center = visibleCenter(target) else { throw CUError("not_clickable", "\(label(target)) has no position to hover.") }
            point = center
        } else if let x = action.double("x"), let y = action.double("y") {
            point = try session.screenPoint(fromPixel: CGPoint(x: x, y: y))
        } else { throw CUError("bad_action", "move needs an element id, or x and y from a screenshot.") }
        guard session.window?.onScreen == true else {
            throw CUError("not_on_screen", "Hovering needs \(session.name)'s window on the current screen. Use the outline or a menu instead.")
        }
        session.makeKey()
        indicate(point)
        poster.mouse(CUMouseEvent(kind: .move, button: .left, point: point, clickState: 0, delayMs: 0), window: session.window?.number)
        session.settler.markChanged()
        return "moved the pointer\(session.element(atScreen: point).map { " over \(label($0))" } ?? "")"
    }

    // MARK: drag

    func drag(_ action: CUObject) async throws -> String {
        let (start, from) = try dragEnd(action["from"], name: "from")
        let (end, to) = try dragEnd(action["to"], name: "to")
        let modifiers = try cuModifierFlags(action.strings("modifiers"))
        let hold = max(0, min(action.int("hold_ms") ?? 0, 5_000))
        guard session.window?.onScreen == true else {
            throw CUError("not_on_screen", "Dragging needs \(session.name)'s window on the current screen. Ask the person to bring it up, or find a menu or keyboard alternative.")
        }
        session.makeKey()
        indicate(start)
        try await runMouse(cuDragEvents(from: start, to: end, holdMs: hold), flags: modifiers)
        session.settler.markChanged()
        let extras = modifiers.isEmpty ? "" : " with \(cuModifierNames(modifiers))"
        return "dragged\(extras) from \(from) to \(to)"
    }

    /// A drag end: [x, y] screenshot pixels, or {id} for an element's visible centre.
    private func dragEnd(_ value: Any?, name: String) throws -> (CGPoint, String) {
        if let pair = value as? [NSNumber], pair.count == 2 {
            return (try session.screenPoint(fromPixel: CGPoint(x: pair[0].doubleValue, y: pair[1].doubleValue)), "(\(pair[0].intValue), \(pair[1].intValue))")
        }
        if let object = value as? CUObject, let id = object.int("id") {
            let target = try element(id: id)
            guard let center = visibleCenter(target) else { throw CUError("not_clickable", "\(label(target)) has no position to drag \(name).") }
            return (center, label(target))
        }
        throw CUError("bad_action", "drag needs \(name) as [x, y] screenshot pixels or {\"id\": n}.")
    }
}

let cuMenuOpenNote = "; its menu is open and takes keys until it closes: choose an item by id from the outline, or press Escape"
