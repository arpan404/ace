import AppKit
import ApplicationServices

/// A menu title reduced for comparison: case, ellipses and edge spaces ignored.
func cuMenuTitleKey(_ title: String) -> String {
    title.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces)
}

enum CUMenuChoice: Equatable {
    case found(Int)
    case ambiguous([String])
    case missing
}

/// Picks the item a path step names: an exact title first; a prefix only when exactly one
/// item starts with it, so "Close" never lands on "Close All" by accident.
func cuChooseMenuItem(titles: [String], wanted: String) -> CUMenuChoice {
    let key = cuMenuTitleKey(wanted)
    guard !key.isEmpty else { return .missing }
    if let exact = titles.firstIndex(where: { cuMenuTitleKey($0) == key }) { return .found(exact) }
    let prefixed = titles.indices.filter { cuMenuTitleKey(titles[$0]).hasPrefix(key) }
    if prefixed.count == 1 { return .found(prefixed[0]) }
    return prefixed.isEmpty ? .missing : .ambiguous(prefixed.map { titles[$0] })
}

/// The window button that does what a window command does. Close, Minimize and Zoom act on the
/// key window, which a background app may lack, while the window's own buttons always work.
/// Only commands that close the whole window map to its close button: "Close Tab" or "Close
/// Editor" must press their own menu item.
func cuWindowButtonAttribute(forCommand title: String) -> String? {
    switch cuMenuTitleKey(title) {
    case "close", "close window": return "AXCloseButton"
    case "minimize", "minimise": return "AXMinimizeButton"
    case "zoom": return "AXZoomButton"
    default: return nil
    }
}

/// Edit menu items that are text commands.
func cuMenuTextCommand(_ title: String) -> CUTextCommand? {
    switch cuMenuTitleKey(title) {
    case "copy": return .copy
    case "cut": return .cut
    case "paste": return .paste
    case "select all": return .selectAll
    default: return nil
    }
}

extension CUActor {
    func windowButton(forCommand title: String) -> AXUIElement? {
        guard let window = session.window?.element, let attribute = cuWindowButtonAttribute(forCommand: title) else { return nil }
        return cuAttribute(window, attribute).map { $0 as! AXUIElement }
    }

    /// Presses a menu item by its path without opening the menu on screen.
    func menu(_ path: [String]) async throws -> String {
        guard !path.isEmpty, path.count <= 8 else { throw CUError("bad_action", "menu needs a path such as [\"File\", \"New Window\"].") }
        guard let bar = cuAttribute(session.element, "AXMenuBar") else { throw CUError("no_menu_bar", "\(session.name) has no menu bar.") }
        var container = bar as! AXUIElement
        var trail: [String] = []
        for (index, title) in path.enumerated() {
            try checkpoint()
            var items = cuAttribute(container, "AXChildren") as? [AXUIElement] ?? []
            if cuRole(container) == "AXMenuBarItem" || cuRole(container) == "AXMenuItem" {
                items = items.filter { cuRole($0) == "AXMenu" }.flatMap { cuAttribute($0, "AXChildren") as? [AXUIElement] ?? [] }
            }
            let titled = items.map { ($0, cuAttribute($0, "AXTitle") as? String ?? "") }.filter { !$0.1.isEmpty }
            let place = trail.isEmpty ? "the menu bar" : trail.joined(separator: " > ")
            let item: (AXUIElement, String)
            switch cuChooseMenuItem(titles: titled.map(\.1), wanted: title) {
            case .found(let found): item = titled[found]
            case .ambiguous(let matches):
                throw CUError("menu_ambiguous", "\"\(title)\" matches several items in \(place): \(matches.prefix(12).joined(separator: ", ")). Use the full title.")
            case .missing:
                throw CUError("menu_not_found", "No \"\(title)\" in \(place). Items: \(titled.map(\.1).prefix(40).joined(separator: ", ")).")
            }
            trail.append(item.1)
            if index == path.count - 1 {
                if cuMenuTitleKey(item.1).hasPrefix("paste"), let focused = focusedElement(), cuIsSecure(focused) {
                    throw CUError("secure_field", "The focused field is a password field. Ask the person to fill it in themselves.")
                }
                // A background app's Edit commands act on no first responder; do them on the text.
                if !session.app.isActive || cuScreenLocked() || session.preserveHumanFocus, let command = cuMenuTextCommand(item.1), let target = textTarget(),
                   let done = await cuRunTextCommand(command, on: target) {
                    session.settler.markChanged()
                    return "chose \(trail.joined(separator: " > ")) (\(done))"
                }
                if !session.app.isActive, let button = windowButton(forCommand: item.1) {
                    let note = try await perform(button, "AXPress")
                    return "chose \(trail.joined(separator: " > ")) (with the window's button)\(note)"
                }
                // AXEnabled is only refreshed when the menu is drawn; the app validates the press.
                try requireAppResponder()
                let note = try await perform(item.0, "AXPress")
                return "chose \(trail.joined(separator: " > "))\(note)"
            }
            container = item.0
        }
        return "chose \(trail.joined(separator: " > "))"
    }
}
