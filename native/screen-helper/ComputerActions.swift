import AppKit
import ApplicationServices

/// Runs model actions against one app session. Each returns a one-line account of what it
/// did, so the model knows which path was taken.
@MainActor struct CUActor {
    let session: CUAppSession
    /// Shows the person where the agent acts, for windows they can see.
    var indicate: (CGPoint) -> Void = { _ in }
    var poster: CUPoster { CUPoster(pid: session.pid) }

    func run(_ action: CUObject) async throws -> String {
        guard let kind = action.string("type") else { throw CUError("bad_action", "Each action needs a type.") }
        // Keyboard, menus and paste act on the app's key window; make ours key first.
        if ["type", "key", "paste", "menu", "set_value", "select_text", "focus"].contains(kind) { session.makeKey() }
        switch kind {
        case "click": return try click(action)
        case "type": return try typeText(action.string("text") ?? "")
        case "key": return try key(action.string("key") ?? "", repeat: action.int("repeat") ?? 1)
        case "set_value": return try setValue(action)
        case "select_text": return try selectText(action)
        case "scroll": return try scroll(action)
        case "action": return try secondary(action)
        case "menu": return try menu(action.strings("path"))
        case "focus": return try focus(element(action))
        case "drag": return try drag(action)
        case "paste":
            try requireKeyboardTarget()
            if focusedIsSecure() { throw CUError("secure_field", "The focused field is a password field. Ask the person to fill it in themselves.") }
            let content = try cuPasteContent(action.string("text") ?? "", format: action.string("format") ?? "text")
            let target = CUTextTarget.focused(in: session.element)
            // Plain text goes straight into the field; the person's clipboard is untouched.
            if content.html == nil, let target, target.replaceSelection(content.plain) {
                session.settler.markChanged()
                return "pasted \(content.plain.count) characters"
            }
            let before = target?.length
            await cuPaste(content, poster: poster, application: session.element)
            session.settler.markChanged()
            if let target, let before, target.length == before {
                // The app ignored a background paste; insert the text itself instead.
                if target.replaceSelection(content.plain) {
                    return "pasted \(content.plain.count) characters as plain text (rich paste needs the app in front; use activate first if formatting matters)"
                }
                throw CUError("paste_ignored", "\(session.name) ignored the paste. Click the field first, or use type or set_value.")
            }
            return "pasted \(content.plain.count) characters\(content.html != nil ? " as rich text" : "")"
        case "activate": return try await activate()
        case "wait":
            let ms = min(max(action.int("ms") ?? 500, 0), 10_000)
            try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            return "waited \(ms) ms"
        default: throw CUError("bad_action", "Unknown action type \"\(kind)\".")
        }
    }

    // MARK: Targets

    private func element(_ action: CUObject) throws -> AXUIElement {
        guard let id = action.int("id") else { throw CUError("bad_action", "This action needs an element id.") }
        guard let element = session.registry.element(id) else {
            throw CUError("stale_element", "Element \(id) is no longer in \(session.name). Observe again and use a current id.")
        }
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &role) == .invalidUIElement {
            throw CUError("stale_element", "Element \(id) went away (the UI changed). Observe again and use a current id.")
        }
        return element
    }

    private func label(_ element: AXUIElement) -> String {
        let id = session.registry.existingId(for: element).map { "\($0) " } ?? ""
        let role = cuAttribute(element, "AXRoleDescription") as? String ?? cuRole(element)
        let name = cuClip((cuAttribute(element, "AXTitle") as? String) ?? (cuAttribute(element, "AXDescription") as? String) ?? cuValueText(cuAttribute(element, "AXValue")), 60)
        return "\(id)\(role)\(name.map { " \"\($0)\"" } ?? "")"
    }

    private func perform(_ element: AXUIElement, _ name: String) throws {
        let result = AXUIElementPerformAction(element, name as CFString)
        guard result == .success else {
            if result == .invalidUIElement { throw CUError("stale_element", "The element went away. Observe again.") }
            if result == .cannotComplete { throw CUError("app_busy", "\(session.name) did not respond (it may be busy or showing a modal dialog). Observe again before retrying.") }
            throw CUError("action_failed", "\(session.name) refused \(name.replacingOccurrences(of: "AX", with: "")) on \(label(element)) (AX error \(result.rawValue)).")
        }
        session.settler.markChanged()
    }

    private func center(_ element: AXUIElement) -> CGPoint? {
        guard let frame = cuFrame(of: element), frame.width > 0, frame.height > 0 else { return nil }
        return CGPoint(x: frame.midX, y: frame.midY)
    }

    /// Close, Minimize and Zoom act on the key window, which a background app lacks; the
    /// window's own buttons do the same thing and work in the background.
    private func windowButton(forCommand title: String) -> AXUIElement? {
        guard let window = session.window?.element else { return nil }
        let command = title.lowercased().replacingOccurrences(of: "…", with: "")
        let attribute = command.hasPrefix("close") && !command.contains("all") ? "AXCloseButton"
            : command.hasPrefix("minimize") && !command.contains("all") ? "AXMinimizeButton"
            : command == "zoom" ? "AXZoomButton" : nil
        return attribute.flatMap { cuAttribute(window, $0) }.map { $0 as! AXUIElement }
    }

    // MARK: Actions

    private func click(_ action: CUObject) throws -> String {
        let right = action.string("button") == "right"
        let count = max(1, min(action.int("count") ?? 1, 3))
        var target: AXUIElement?
        var point: CGPoint?
        if action.int("id") != nil { target = try element(action) }
        else if let x = action.double("x"), let y = action.double("y") {
            let global = try session.globalPoint(x: x, y: y)
            point = global
            if let hit = session.hitTest(global) { target = session.registry.element(hit.id) }
        } else { throw CUError("bad_action", "click needs an element id, or x and y from a screenshot.") }

        if session.window?.onScreen == true, let shown = point ?? target.flatMap(center) { indicate(shown) }
        if let target {
            let actions = cuActionNames(target)
            let role = cuRole(target)
            if right {
                if actions.contains("AXShowMenu") { try perform(target, "AXShowMenu"); return "opened the context menu of \(label(target))" }
            } else if count == 2, actions.contains("AXOpen") {
                try perform(target, "AXOpen"); return "opened \(label(target))"
            } else if count == 1 {
                if actions.contains("AXPress") { try perform(target, "AXPress"); return "pressed \(label(target))" }
                if cuTextInputRoles.contains(role) { return try focus(target) }
                if ["AXRow", "AXCell", "AXOutlineRow", "AXStaticText", "AXImage"].contains(role), let row = selectable(target) {
                    AXUIElementSetAttributeValue(row, "AXSelected" as CFString, kCFBooleanTrue)
                    session.settler.markChanged()
                    return "selected \(label(row))"
                }
                var ancestor = cuAttribute(target, "AXParent").map { $0 as! AXUIElement }
                for _ in 0..<3 {
                    guard let current = ancestor else { break }
                    if cuActionNames(current).contains("AXPress") { try perform(current, "AXPress"); return "pressed \(label(current))" }
                    ancestor = cuAttribute(current, "AXParent").map { $0 as! AXUIElement }
                }
            }
            point = point ?? center(target)
        }
        guard let point else { throw CUError("not_clickable", "That element has no position to click. Try an action listed on it, a menu path, or the keyboard.") }
        guard session.window?.onScreen == true else {
            throw CUError("not_clickable", "Nothing at that spot can be pressed through accessibility, and \(session.name)'s window is not on the current screen (another Space, minimized or behind a full-screen app), so a mouse click would not land. Use an element id with an action, a menu path, or keys instead.")
        }
        poster.click(at: point, window: session.window?.number, button: right ? .right : .left, count: count)
        session.settler.markChanged()
        return "\(right ? "right-" : count == 2 ? "double-" : "")clicked at the point\(target.map { " over \(label($0))" } ?? "")"
    }

    /// The row or cell a click on its content means to select.
    private func selectable(_ element: AXUIElement) -> AXUIElement? {
        var current: AXUIElement? = element
        for _ in 0..<4 {
            guard let item = current else { return nil }
            var settable = DarwinBoolean(false)
            if ["AXRow", "AXOutlineRow", "AXCell"].contains(cuRole(item)),
               AXUIElementIsAttributeSettable(item, "AXSelected" as CFString, &settable) == .success, settable.boolValue { return item }
            current = cuAttribute(item, "AXParent").map { $0 as! AXUIElement }
        }
        return nil
    }

    private func focusedIsSecure() -> Bool {
        guard let focused = cuAttribute(session.element, "AXFocusedUIElement") else { return false }
        let element = focused as! AXUIElement
        return cuRole(element) == "AXSecureTextField" || (cuAttribute(element, "AXSubrole") as? String) == "AXSecureTextField"
    }

    /// Keys go to the app's key window; with no window they would silently go nowhere.
    private func requireKeyboardTarget() throws {
        guard session.window != nil || cuAttribute(session.element, "AXFocusedUIElement") != nil else {
            throw CUError("no_window", "\(session.name) has no open window to receive keys. Open one first, e.g. menu [\"File\", \"New\"].")
        }
    }

    private func typeText(_ text: String) throws -> String {
        guard !text.isEmpty else { throw CUError("bad_action", "type needs text.") }
        try requireKeyboardTarget()
        guard text.count <= 5_000 else { throw CUError("bad_action", "Type at most 5000 characters at a time; use set_value for long text.") }
        if focusedIsSecure() { throw CUError("secure_field", "The focused field is a password field. Ask the person to type it themselves.") }
        if session.window?.onScreen == true, let focused = cuAttribute(session.element, "AXFocusedUIElement"), let at = center(focused as! AXUIElement) { indicate(at) }
        poster.type(text)
        session.settler.markChanged()
        return "typed \(text.count) character\(text.count == 1 ? "" : "s")"
    }

    private func key(_ name: String, repeat count: Int) throws -> String {
        let chord = try cuParseChord(name)
        if !chord.flags.contains(.maskCommand) { try requireKeyboardTarget() }
        if let command = cuTextCommand(chord), let target = CUTextTarget.focused(in: session.element), !session.app.isActive,
           let done = cuRunTextCommand(command, on: target) {
            session.settler.markChanged()
            return "pressed \(name) (\(done))"
        }
        if let item = cuMenuItem(for: chord, in: session.element) {
            let title = cuAttribute(item, "AXTitle") as? String ?? name
            if !session.app.isActive, let button = windowButton(forCommand: title) {
                try perform(button, "AXPress")
                return "pressed \(name) (\(title), with the window's button)"
            }
            for _ in 0..<max(1, min(count, 50)) { try perform(item, "AXPress") }
            return "pressed \(name) (\(title))\(count > 1 ? " ×\(count)" : "")"
        }
        for _ in 0..<max(1, min(count, 50)) { poster.chord(chord); usleep(8_000) }
        session.settler.markChanged()
        return "pressed \(name)\(count > 1 ? " ×\(count)" : "")"
    }

    private func focus(_ element: AXUIElement) throws -> String {
        if let window = session.window { AXUIElementSetAttributeValue(window.element, "AXMain" as CFString, kCFBooleanTrue) }
        let result = AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue)
        guard result == .success else { throw CUError("action_failed", "\(session.name) would not focus \(label(element)). Try clicking it instead.") }
        session.settler.markChanged()
        return "focused \(label(element))"
    }

    private func setValue(_ action: CUObject) throws -> String {
        let target = try element(action)
        let role = cuRole(target)
        if role == "AXSecureTextField" { throw CUError("secure_field", "That is a password field. Ask the person to fill it in themselves.") }
        let value: CFTypeRef
        if let text = action["value"] as? String { value = text as CFString }
        else if let number = action["value"] as? NSNumber {
            value = CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? 1 : 0) as CFNumber : number
        } else { throw CUError("bad_action", "set_value needs a value (text, number or true/false).") }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(target, "AXValue" as CFString, &settable) == .success, settable.boolValue else {
            throw CUError("not_settable", "\(label(target))'s value can't be set directly. Click it and type, or use the keyboard.")
        }
        let result = AXUIElementSetAttributeValue(target, "AXValue" as CFString, value)
        guard result == .success else { throw CUError("action_failed", "\(session.name) rejected the new value for \(label(target)) (AX error \(result.rawValue)).") }
        session.settler.markChanged()
        return "set \(label(target))"
    }

    private func selectText(_ action: CUObject) throws -> String {
        let target = try element(action)
        guard let wanted = action.string("text"), !wanted.isEmpty else { throw CUError("bad_action", "select_text needs the text to select.") }
        guard let full = cuAttribute(target, "AXValue") as? String else { throw CUError("not_text", "\(label(target)) has no text to select.") }
        let haystack = full as NSString
        var range = haystack.range(of: wanted)
        if let prefix = action.string("prefix") {
            let anchored = haystack.range(of: prefix + wanted)
            if anchored.location != NSNotFound { range = NSRange(location: anchored.location + (prefix as NSString).length, length: (wanted as NSString).length) }
        }
        guard range.location != NSNotFound else { throw CUError("text_not_found", "\"\(wanted)\" is not in \(label(target)). Copy the text exactly as the outline shows it.") }
        if action.string("cursor") == "after" { range = NSRange(location: range.location + range.length, length: 0) }
        if action.string("cursor") == "before" { range = NSRange(location: range.location, length: 0) }
        _ = try? focus(target)
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &cfRange),
              AXUIElementSetAttributeValue(target, "AXSelectedTextRange" as CFString, value) == .success else {
            throw CUError("action_failed", "\(session.name) would not change the selection in \(label(target)).")
        }
        session.settler.markChanged()
        return range.length == 0 ? "placed the cursor in \(label(target))" : "selected \"\(cuClip(wanted, 40) ?? "")\" in \(label(target))"
    }

    private func scroll(_ action: CUObject) throws -> String {
        let direction = action.string("direction") ?? "down"
        guard ["up", "down", "left", "right"].contains(direction) else { throw CUError("bad_action", "direction is up, down, left or right.") }
        let pages = max(0.1, min(action.double("pages") ?? 1, 20))
        var start: AXUIElement?
        var point: CGPoint?
        if action.int("id") != nil { start = try element(action) }
        else if let x = action.double("x"), let y = action.double("y") {
            let global = try session.globalPoint(x: x, y: y)
            point = global
            start = session.hitTest(global).flatMap { session.registry.element($0.id) }
        }
        if start == nil, let first = session.lastNodes.first(where: { $0.axRole == "AXScrollArea" || $0.axRole == "AXWebArea" }) {
            start = session.registry.element(first.id)
        }
        let byPage = "AXScroll\(direction.prefix(1).uppercased() + direction.dropFirst())ByPage"
        var current = start
        for _ in 0..<8 {
            guard let element = current else { break }
            if cuActionNames(element).contains(byPage), pages >= 1 {
                for _ in 0..<Int(pages.rounded()) { try perform(element, byPage) }
                return "scrolled \(label(element)) \(direction) \(Int(pages.rounded())) page(s)"
            }
            if let moved = scrollBar(element, direction: direction, pages: pages) { return moved }
            current = cuAttribute(element, "AXParent").map { $0 as! AXUIElement }
        }
        guard session.window?.onScreen == true, let at = point ?? start.flatMap(center) else {
            throw CUError("not_scrollable", "Found nothing scrollable there. Pass the id of a scroll area or list, or use keys such as PageDown.")
        }
        let height = Double(session.window?.frame.height ?? 600) * 0.8 * pages
        let dy = Int32(direction == "down" ? -height : direction == "up" ? height : 0)
        let dx = Int32(direction == "right" ? -height : direction == "left" ? height : 0)
        poster.scroll(at: at, window: session.window?.number, dx: dx, dy: dy)
        session.settler.markChanged()
        return "scrolled \(direction) with the mouse wheel"
    }

    /// Moves a scroll area's bar by about a page, for apps without scroll-by-page actions.
    private func scrollBar(_ element: AXUIElement, direction: String, pages: Double) -> String? {
        guard cuRole(element) == "AXScrollArea" else { return nil }
        let vertical = direction == "up" || direction == "down"
        let bar = (cuAttribute(element, vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar")).map { $0 as! AXUIElement }
        guard let bar, let value = (cuAttribute(bar, "AXValue") as? NSNumber)?.doubleValue else { return nil }
        let content = (cuAttribute(element, "AXContents") as? [AXUIElement])?.first.flatMap(cuFrame(of:))
        let visible = cuFrame(of: element)
        var page = 0.25
        if let content, let visible {
            let total = vertical ? content.height - visible.height : content.width - visible.width
            if total > 0 { page = Double((vertical ? visible.height : visible.width) * 0.9 / total) }
        }
        let next = min(1, max(0, value + (direction == "down" || direction == "right" ? 1 : -1) * page * pages))
        guard AXUIElementSetAttributeValue(bar, "AXValue" as CFString, next as CFNumber) == .success else { return nil }
        session.settler.markChanged()
        return "scrolled \(label(element)) \(direction) to \(Int(next * 100))%"
    }

    private func secondary(_ action: CUObject) throws -> String {
        let target = try element(action)
        guard let wanted = action.string("name"), !wanted.isEmpty else { throw CUError("bad_action", "action needs the action name shown on the element.") }
        let available = cuActionNames(target)
        let match = available.first { $0 == wanted || cuReadableAction($0)?.lowercased() == wanted.lowercased() || $0.lowercased() == "ax" + wanted.replacingOccurrences(of: " ", with: "").lowercased() }
        guard let match else {
            let names = available.compactMap(cuReadableAction)
            throw CUError("unknown_action", "\(label(target)) has no \"\(wanted)\" action. It offers: \(names.isEmpty ? "only a plain click" : names.joined(separator: ", ")).")
        }
        try perform(target, match)
        return "performed \(cuReadableAction(match) ?? match) on \(label(target))"
    }

    /// Presses a menu item by its path without opening the menu on screen.
    private func menu(_ path: [String]) throws -> String {
        guard !path.isEmpty, path.count <= 8 else { throw CUError("bad_action", "menu needs a path such as [\"File\", \"New Window\"].") }
        guard let bar = cuAttribute(session.element, "AXMenuBar") else { throw CUError("no_menu_bar", "\(session.name) has no menu bar.") }
        func normalized(_ text: String) -> String {
            text.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces)
        }
        var container = bar as! AXUIElement
        var trail: [String] = []
        for (index, title) in path.enumerated() {
            var items = cuAttribute(container, "AXChildren") as? [AXUIElement] ?? []
            if cuRole(container) == "AXMenuBarItem" || cuRole(container) == "AXMenuItem" {
                items = items.filter { cuRole($0) == "AXMenu" }.flatMap { cuAttribute($0, "AXChildren") as? [AXUIElement] ?? [] }
            }
            let titled = items.map { ($0, cuAttribute($0, "AXTitle") as? String ?? "") }.filter { !$0.1.isEmpty }
            guard let found = titled.first(where: { normalized($0.1) == normalized(title) }) ?? titled.first(where: { normalized($0.1).hasPrefix(normalized(title)) }) else {
                let choices = titled.map(\.1).prefix(40).joined(separator: ", ")
                throw CUError("menu_not_found", "No \"\(title)\" in \(trail.isEmpty ? "the menu bar" : trail.joined(separator: " > ")). Items: \(choices).")
            }
            trail.append(found.1)
            if index == path.count - 1 {
                if !session.app.isActive, let button = windowButton(forCommand: found.1) {
                    try perform(button, "AXPress")
                    return "chose \(trail.joined(separator: " > ")) (with the window's button)"
                }
                // AXEnabled is only refreshed when the menu is drawn; the app validates the press.
                try perform(found.0, "AXPress")
                return "chose \(trail.joined(separator: " > "))"
            }
            container = found.0
        }
        return "chose \(trail.joined(separator: " > "))"
    }

    /// Last resort: bring the app and its window to the front. This takes focus from the person.
    private func activate() async throws -> String {
        session.app.unhide()
        if let window = session.window {
            AXUIElementSetAttributeValue(window.element, "AXMinimized" as CFString, kCFBooleanFalse)
            AXUIElementSetAttributeValue(window.element, "AXMain" as CFString, kCFBooleanTrue)
            AXUIElementPerformAction(window.element, "AXRaise" as CFString)
        }
        _ = session.app.activate(options: [])
        try? await Task.sleep(nanoseconds: 300_000_000)
        session.settler.markChanged()
        return session.app.isActive ? "brought \(session.name) to the front" : "asked \(session.name) to come to the front; macOS may not have switched to it yet"
    }

    private func drag(_ action: CUObject) throws -> String {
        let from = action["from"] as? [NSNumber] ?? [], to = action["to"] as? [NSNumber] ?? []
        guard from.count == 2, to.count == 2 else { throw CUError("bad_action", "drag needs from:[x,y] and to:[x,y] in screenshot pixels.") }
        guard session.window?.onScreen == true else { throw CUError("not_on_screen", "Dragging needs \(session.name)'s window on the current screen. Ask the person to bring it up, or find a menu or keyboard alternative.") }
        let start = try session.globalPoint(x: from[0].doubleValue, y: from[1].doubleValue)
        let end = try session.globalPoint(x: to[0].doubleValue, y: to[1].doubleValue)
        poster.drag(from: start, to: end, window: session.window?.number)
        session.settler.markChanged()
        return "dragged"
    }
}
