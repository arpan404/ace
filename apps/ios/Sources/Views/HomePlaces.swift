import SwiftUI

/// A place outside the thread lists, open over the home screen in Settings' sheet: Pull requests
/// (on one of its lists), a machine tool, Machines or Settings, at `root` with `start` pushed on it.
struct PlaceSheet: Identifiable {
    let id: Int
    let root: SettingsRoute
    var start: [SettingsRoute] = []
    var forge = ForgeKind.pulls

    /// What a place opens, on the machine whose tools it shows; nil when it needs a machine and
    /// none is paired.
    static func of(_ place: SearchPlace, machine: String?, id: Int) -> PlaceSheet? {
        switch place {
        case .pulls: return PlaceSheet(id: id, root: .pulls)
        case .issues: return PlaceSheet(id: id, root: .pulls, forge: .issues)
        case .machines: return PlaceSheet(id: id, root: .machines)
        case .settings: return PlaceSheet(id: id, root: .settings)
        case .history: return PlaceSheet(id: id, root: .history)
        case .archived: return PlaceSheet(id: id, root: .archive)
        case .automations, .skills, .usage:
            guard let machine, let tool = place.tool else { return nil }
            return PlaceSheet(id: id, root: .tool(tool, machine: machine))
        }
    }

    /// A search command for a settings page or a machine tool (`settings:appearance`,
    /// `tool:providers`), opened inside Settings so Back lands on its list.
    static func of(command id: String, machine: String?, serial: Int) -> PlaceSheet? {
        if id == "settings" { return PlaceSheet(id: serial, root: .settings) }
        if id.hasPrefix("settings:") {
            return PlaceSheet(id: serial, root: .settings, start: SettingsRoute.linked(String(id.dropFirst(9))))
        }
        if id.hasPrefix("tool:"), let tool = SettingsTool(rawValue: String(id.dropFirst(5))), let machine {
            return PlaceSheet(id: serial, root: .settings, start: [.tool(tool, machine: machine)])
        }
        return nil
    }
}

/// What a palette command (`bridge/palette.ts`) does on the home screen, by its id.
enum HomeCommand: Equatable {
    case newThread, newChat, select
    /// One of the places outside the lists: Pull requests, Issues, History, Archived.
    case place(SearchPlace)
    /// Show only this machine's threads; empty for every machine.
    case machine(String)
    /// One of the open thread's places.
    case thread(ThreadDestination)
    /// A settings page or machine tool, opened inside Settings (`PlaceSheet.of(command:)`).
    case settings(String)

    init(id: String) {
        switch id {
        case "new-thread": self = .newThread
        case "new-chat": self = .newChat
        case "select": self = .select
        case "pulls": self = .place(.pulls)
        case "issues": self = .place(.issues)
        case "history": self = .place(.history)
        case "archived": self = .place(.archived)
        default:
            if id.hasPrefix("machine:") { self = .machine(String(id.dropFirst(8))) }
            else if id.hasPrefix("thread:"), let destination = ThreadDestination(command: String(id.dropFirst(7))) { self = .thread(destination) }
            else { self = .settings(id) }
        }
    }
}

extension View {
    /// Opens `sheet` in Settings' sheet; a thread or New thread asked from it opens on the home
    /// screen once it closes.
    func placeSheet(_ sheet: Binding<PlaceSheet?>, inbox: MachineInbox, machines: MachinesModel?, lock: AppLock?,
                    places: MorePlaces) -> some View {
        self.sheet(item: sheet) { place in
            SettingsSheet(inbox: inbox, places: places, machines: machines, lock: lock, root: place.root, start: place.start,
                          forgeStart: place.forge)
                .environment(\.otherMachines, OtherMachines(client: { inbox.client($0) }))
        }
    }
}
