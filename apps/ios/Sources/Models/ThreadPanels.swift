import Foundation
import Observation
import SwiftUI

/// A tool the iPad's side panel can hold. Each is an existing screen of the app, shown in the
/// panel instead of over the thread (`Views/Workspace/PanelContent.swift`).
enum PanelTool: String, CaseIterable, Sendable {
    case changes, files, terminal, browser, agents
    /// Run and preview lives on `ace/ios-gaps-projects-machines-notes` (`ProjectScriptsView`).
    /// Once that screen is on main: add `case preview` here and its screen in `PanelContent`;
    /// the shared rules (`@ace/ui-core/tablet-workspace`) already offer it as "Run and preview".
    // case preview

    /// What this build can draw; the bridge offers and opens nothing else.
    static let available = allCases.map(\.rawValue)
}

/// One thread's side panel as the shared rules left it (`bridge/workspace.ts`).
struct PanelView: Decodable, Equatable, Sendable {
    struct Tab: Decodable, Equatable, Identifiable, Sendable {
        let key: String
        let kind: String
        let title: String
        let pinned: Bool
        var id: String { key }
        var tool: PanelTool? { PanelTool(rawValue: kind) }
    }
    struct Tool: Decodable, Equatable, Identifiable, Sendable {
        let kind: String
        let label: String
        let open: Bool
        var id: String { kind }
    }
    struct Limits: Decodable, Equatable, Sendable {
        let min: Double
        let keep: Double
    }
    let scope: String
    let open: Bool
    let active: String?
    let tabs: [Tab]
    let size: Double
    let canReopen: Bool
    let tools: [Tool]
    let limits: Limits

    var shown: Tab? { tabs.first { $0.key == active } ?? tabs.first }
}

/// Where the panel goes in the window, from the limits the shared rules send.
enum PanelPlace: Equatable {
    /// Beside the thread.
    case beside
    /// Beside the thread once the thread list steps aside.
    case yield
    /// Too narrow, or compact: the tools open over the thread, as on a phone.
    case none

    /// `width` is the thread's column as it would be with the list showing; `list` the list's
    /// width (0 when the person hid it).
    static func of(regular: Bool, width: CGFloat, list: CGFloat, limits: PanelView.Limits) -> PanelPlace {
        guard regular else { return .none }
        let needed = CGFloat(limits.min + limits.keep)
        if width >= needed { return .beside }
        return width + list >= needed ? .yield : .none
    }

    /// The panel's width in a column `width` wide: its size, between the minimum and what
    /// leaves the thread its share.
    static func width(size: Double, column: CGFloat, limits: PanelView.Limits) -> CGFloat {
        let low = CGFloat(limits.min)
        let high = max(low, column - CGFloat(limits.keep))
        return min(max(CGFloat(size), low), high).rounded()
    }
}

/// The panels the bridge sent, by thread. Only the threads opened lately are kept.
@MainActor @Observable final class ThreadPanels {
    private(set) var views: [String: PanelView] = [:]
    @ObservationIgnored private var order: [String] = []

    func apply(_ view: PanelView) {
        if views[view.scope] != view { views[view.scope] = view }
        order.removeAll { $0 == view.scope }
        order.append(view.scope)
        while order.count > 8 { views[order.removeFirst()] = nil }
    }
    func reset() { views = [:]; order = [] }

    /// A file picked in the panel's Files, for that thread's composer to take as `@path`.
    struct Mention: Equatable { let scope: String; let path: String; let id: Int }
    private(set) var mentioned: Mention?
    func mention(_ scope: String, path: String) {
        mentioned = Mention(scope: scope, path: path, id: (mentioned?.id ?? 0) + 1)
    }
}

extension ClientModel {
    /// Ask for a thread's panel (`op` nil), or apply what the person did to it.
    func panel(_ scope: String, _ op: [String: Any]? = nil) {
        var value: [String: Any] = ["type": "workspace", "scope": scope, "tools": PanelTool.available]
        if let op { value["op"] = op }
        action(value)
    }
}
