import AppKit
import ApplicationServices

/// A password field, native (role) or web (subrole). Text never goes into one from the agent.
func cuIsSecure(_ element: AXUIElement) -> Bool {
    cuRole(element) == "AXSecureTextField" || (cuAttribute(element, "AXSubrole") as? String) == "AXSecureTextField"
}

let cuNoEffectNote = ". No visible effect; the app may ignore background keys: try set_value, paste, or activate."

/// Apps known to drop multi-character key events (they read one character per key), by pid.
/// Learned on first use, so only one chunk per app is ever retried.
@MainActor enum CUTypingModes {
    static var perCharacter: Set<pid_t> = []
    static var chunked: Set<pid_t> = []
}

extension CUActor {
    /// Keys go to the app's key window; with no window they would silently go nowhere.
    func requireKeyboardTarget() throws {
        guard session.window != nil || focusedElement() != nil else {
            throw CUError("no_window", "\(session.name) has no open window to receive keys. Open one first, e.g. menu [\"File\", \"New\"].")
        }
    }

    /// A tracking menu takes every key the app gets, and possibly the person's too.
    func menuTracking() -> Bool {
        if !cuOpenMenus(session.element).isEmpty { return true }
        return focusedElement().map { ["AXMenu", "AXMenuItem"].contains(cuRole($0)) } ?? false
    }

    private func refuseWhileMenuOpen() throws {
        if menuTracking() {
            throw CUError("menu_open", "\(session.name) has a menu open, which would swallow the text. Choose an item by id from the outline, or press Escape (key) to close it first.")
        }
    }

    /// Focuses the element an `id` names before keyboard input, waiting briefly for it to take.
    private func focusTarget(_ action: CUObject) async throws {
        guard action.int("id") != nil else { try requireKeyboardTarget(); return }
        let target = try element(action)
        _ = try focus(target)
        for _ in 0..<4 {
            if let now = focusedElement(), CFEqual(now, target) { return }
            try await pause(ms: 25)
        }
    }

    private func refuseSecure(_ element: AXUIElement?, verb: String) throws {
        if let element, cuIsSecure(element) {
            throw CUError("secure_field", "The focused field is a password field. Ask the person to \(verb) it themselves.")
        }
    }

    // MARK: type

    func typeText(_ action: CUObject) async throws -> String {
        let text = action.string("text") ?? ""
        guard !text.isEmpty else { throw CUError("bad_action", "type needs text.") }
        guard text.count <= 5_000 else { throw CUError("bad_action", "Type at most 5000 characters at a time; use set_value or paste for long text.") }
        try await focusTarget(action)
        let focused = focusedElement()
        try refuseSecure(focused, verb: "type")
        try refuseWhileMenuOpen()
        if session.window?.onScreen == true, let focused, let at = visibleCenter(focused) { indicate(at) }
        let target = focused.flatMap(CUTextTarget.init)
        let before = target?.state
        let count = "\(text.count) character\(text.count == 1 ? "" : "s")"
        // An input method would compose posted keys; insert the text itself instead.
        if CUKeyboard.inputMethodActive, let target {
            switch await target.insert(text) {
            case .changed: session.settler.markChanged(); return "typed \(count) (inserted directly because an input method is active)"
            case .unverified: session.settler.markChanged(); return "typed \(count) (inserted directly because an input method is active; unconfirmed)"
            case .ignored, .refused: break
            }
        }
        try await postTyping(text, target: target)
        session.settler.markChanged()
        var line = "typed \(count)"
        if let target, let before, before.observable, !(await target.changed(since: before, withinMs: 300)) { line += cuNoEffectNote }
        return line
    }

    /// Posts text as key events: chunks of up to 20 characters per event where the app takes
    /// them (checked on the first chunk), one key per character otherwise. Yields to the run
    /// loop between events so Esc, cancel and accessibility notifications keep flowing.
    private func postTyping(_ text: String, target: CUTextTarget?) async throws {
        let layout = CUKeyboard.current()
        let pid = session.pid
        var chunked = target?.state.observable == true && !CUTypingModes.perCharacter.contains(pid)
        var verified = CUTypingModes.chunked.contains(pid)
        var lastCheck = DispatchTime.now().uptimeNanoseconds
        func breathe(_ ms: UInt64) async throws {
            try? await Task.sleep(nanoseconds: ms * 1_000_000)
            let now = DispatchTime.now().uptimeNanoseconds
            if now - lastCheck >= 40_000_000 { lastCheck = now; try checkpoint() }
        }
        // With an input method selected, a key code would start a composition; Unicode alone may not.
        let composing = CUKeyboard.inputMethodActive
        func perCharacter(_ characters: Substring) async throws {
            for character in characters {
                if composing { poster.typeChunk(String(character)) } else { poster.typeCharacter(character, layout: layout) }
                try await breathe(1)
            }
        }
        try checkpoint()
        for step in cuTypingPlan(text, chunk: chunked ? 20 : 1) {
            switch step {
            case .key(let code, let typed):
                poster.key(code, text: typed)
                try await breathe(2)
            case .text(let chunk):
                if !chunked { try await perCharacter(Substring(chunk)); continue }
                if verified || chunk.count == 1 {
                    poster.typeChunk(chunk)
                    try await breathe(2)
                    continue
                }
                guard let target else { continue }
                let before = target.state
                poster.typeChunk(chunk)
                let landed = await landedUnits(target, since: before, expected: chunk.utf16.count)
                if landed >= chunk.utf16.count {
                    verified = true
                    CUTypingModes.chunked.insert(pid)
                    continue
                }
                // The app took only part of the event: finish this chunk one key at a time.
                chunked = false
                CUTypingModes.perCharacter.insert(pid)
                var skipped = 0
                try await perCharacter(chunk.drop { character in
                    guard skipped < landed else { return false }
                    skipped += character.utf16.count
                    return true
                })
            }
        }
    }

    private func landedUnits(_ target: CUTextTarget, since before: CUTextState, expected: Int) async -> Int {
        var landed = 0
        for _ in 0..<30 {
            landed = cuLandedUnits(before: before, after: target.state) ?? 0
            if landed >= expected { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return landed
    }

    // MARK: key

    func key(_ action: CUObject) async throws -> String {
        let name = action.string("key") ?? ""
        let chord = try cuParseChord(name)
        let count = max(1, min(action.int("repeat") ?? 1, 50))
        let hold = max(0, min(action.int("hold_ms") ?? 0, 5_000))
        if action.int("id") != nil || !chord.flags.contains(.maskCommand) { try await focusTarget(action) }
        let focused = focusedElement()
        let command = cuTextCommand(chord)
        if chord.typesText || command == .paste { try refuseSecure(focused, verb: "fill") }
        if let command, !session.app.isActive, let target = CUTextTarget.focused(in: session.element), let done = await cuRunTextCommand(command, on: target) {
            session.settler.markChanged()
            return "pressed \(name) (\(done))"
        }
        if let item = cuMenuItem(for: chord, in: session.element) {
            let title = cuAttribute(item, "AXTitle") as? String ?? name
            if !session.app.isActive, let button = windowButton(forCommand: title) {
                let note = try await perform(button, "AXPress")
                return "pressed \(name) (\(title), with the window's button)\(note)"
            }
            var note = ""
            for index in 0..<count {
                if index > 0 { try checkpoint() }
                note = try await perform(item, "AXPress")
            }
            return "pressed \(name) (\(title))\(count > 1 ? " ×\(count)" : "")\(note)"
        }
        let target = chord.typesText ? focused.flatMap(CUTextTarget.init) : nil
        let before = target?.state
        if hold > 0 { try await holdKey(chord, ms: hold) }
        else {
            for index in 0..<count {
                try checkpoint()
                poster.chord(chord)
                if index < count - 1 { try? await Task.sleep(nanoseconds: 8_000_000) }
            }
        }
        session.settler.markChanged()
        var line = "pressed \(name)\(count > 1 && hold == 0 ? " ×\(count)" : "")\(hold > 0 ? " for \(hold) ms" : "")"
        if menuTracking() { line += " (a menu is open: its items are in the outline)" }
        if let target, let before, before.observable, !(await target.changed(since: before, withinMs: 300)) { line += cuNoEffectNote }
        return line
    }

    /// Holds a key down, repeating like a keyboard after a short delay; always releases it.
    private func holdKey(_ chord: CUChord, ms: Int) async throws {
        poster.keyEvent(chord.code, down: true, flags: chord.flags, text: chord.text)
        do {
            try await pause(ms: min(ms, 400))
            var held = min(ms, 400)
            while held < ms {
                if !chord.isShortcut { poster.keyEvent(chord.code, down: true, flags: chord.flags, text: chord.text, autorepeat: true) }
                let slice = min(50, ms - held)
                try await pause(ms: slice)
                held += slice
            }
        } catch {
            poster.keyEvent(chord.code, down: false, flags: chord.flags, text: chord.text)
            throw error
        }
        poster.keyEvent(chord.code, down: false, flags: chord.flags, text: chord.text)
    }

    // MARK: paste

    func paste(_ action: CUObject) async throws -> String {
        try await focusTarget(action)
        try refuseSecure(focusedElement(), verb: "fill")
        try refuseWhileMenuOpen()
        let content = try cuPasteContent(action.string("text") ?? "", format: action.string("format") ?? "text")
        let target = CUTextTarget.focused(in: session.element)
        let count = content.plain.count
        // Plain text goes straight into the field; the person's clipboard is untouched.
        if content.html == nil, let target {
            switch await target.insert(content.plain) {
            case .changed: session.settler.markChanged(); return "pasted \(count) characters"
            case .unverified: session.settler.markChanged(); return "pasted \(count) characters (the app does not report its text, so this is unconfirmed)"
            case .ignored, .refused: break
            }
        }
        try checkpoint()
        let before = target?.state
        await cuPaste(content, poster: poster, application: session.element)
        session.settler.markChanged()
        guard let target, let before, before.observable else { return "pasted \(count) characters\(content.html != nil ? " as rich text" : "")" }
        if await target.changed(since: before, withinMs: 300) { return "pasted \(count) characters\(content.html != nil ? " as rich text" : "")" }
        // The app ignored a background paste; insert the text itself instead.
        switch await target.insert(content.plain) {
        case .changed, .unverified:
            return "pasted \(count) characters as plain text (rich paste needs the app in front; use activate first if formatting matters)"
        case .ignored, .refused:
            throw CUError("paste_ignored", "\(session.name) ignored the paste. Click the field first, or use type or set_value.")
        }
    }
}
