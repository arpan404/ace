import Foundation

/// One tab of the model picker: Favorites, or one account of one provider.
struct ModelPickerTab: Identifiable, Equatable {
    static let favorites = "favorites"
    let id: String
    /// The provider whose mark it shows; nil for Favorites.
    let provider: String?
    let name: String
    /// Why its models can't be picked now, in words; nil when they can.
    var note: String? = nil
}

/// One model the picker lists: its name, a muted line only when it says something (the account a
/// Favorites row runs on), a check when it's the one chosen and a star when it's a favorite.
struct ModelPickerRow: Identifiable, Equatable {
    let id: String
    let label: String
    var detail: String? = nil
    let chosen: Bool
    let starred: Bool
    /// The picker key (`modelKey`) a star saves.
    let key: String
}

/// Whether a model's name matches what was typed into "Find a model".
enum ModelSearch {
    static func matches(_ query: String, _ words: String...) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || words.contains { $0.localizedCaseInsensitiveContains(needle) }
    }
    static func active(_ query: String) -> Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
}

/// Which tab the picker opens on, as the web's does: Favorites when the person has starred any of
/// the models it lists, else the tab the thread or draft runs on, else the first one.
enum ModelPickerStart {
    static func tab(_ tabs: [ModelPickerTab], hasFavorites: Bool, current: String?) -> String {
        if hasFavorites, tabs.contains(where: { $0.id == ModelPickerTab.favorites }) { return ModelPickerTab.favorites }
        if let current, tabs.contains(where: { $0.id == current }) { return current }
        return tabs.first { $0.id != ModelPickerTab.favorites }?.id ?? tabs.first?.id ?? ""
    }
}

/// New thread's picker, from the bridge's tabs (`newThreadTabs`): each tab's models resolved to
/// the agents' rows. A search looks through every account's tab, each row naming its account,
/// as the web's search does.
enum NewThreadPickerRows {
    struct Chosen: Equatable { let provider: String; let key: String; let account: String }

    static func tabs(_ read: ComposeAgentsRead) -> [ModelPickerTab] {
        read.tabs.map { ModelPickerTab(id: $0.id, provider: $0.provider, name: $0.name, note: $0.reason) }
    }

    /// The rows the shown tab lists and how many more wait behind "More models".
    static func rows(_ read: ComposeAgentsRead, tab id: String, chosen: Chosen?, query: String, expanded: Bool)
        -> (rows: [ModelPickerRow], hidden: Int) {
        let starred = Set(read.favorites)
        let names = Dictionary(read.tabs.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        func row(_ ref: ComposeTab.Ref, named: Bool) -> ModelPickerRow? {
            guard let (agent, model) = resolve(read.agents, ref) else { return nil }
            let detail = named ? names["\(agent.provider):\(ref.account)"] ?? agent.name : nil
            return ModelPickerRow(id: model.id, label: model.label, detail: detail,
                                  chosen: chosen == Chosen(provider: agent.provider, key: model.key, account: model.account),
                                  starred: starred.contains(model.key), key: model.key)
        }
        if ModelSearch.active(query) {
            var seen = Set<String>()
            let found = read.tabs.filter { !$0.favorites }.flatMap(\.models)
                .compactMap { row($0, named: true) }
                .filter { ModelSearch.matches(query, $0.label) && seen.insert($0.id).inserted }
            return (found, 0)
        }
        guard let tab = read.tabs.first(where: { $0.id == id }) else { return ([], 0) }
        let refs = expanded ? tab.models : Array(tab.models.prefix(tab.lead))
        return (refs.compactMap { row($0, named: tab.favorites) }, tab.models.count - refs.count)
    }

    static func resolve(_ agents: [ComposeAgent], _ ref: ComposeTab.Ref) -> (ComposeAgent, ComposeAgent.Model)? {
        for agent in agents {
            if let model = agent.models.first(where: { $0.key == ref.key && $0.account == ref.account }) { return (agent, model) }
        }
        return nil
    }
}

/// The open thread's picker: its provider's models on the account it runs on, and the ones
/// starred among them under Favorites. A thread keeps its provider, so there is no other tab.
enum ThreadPickerRows {
    static let account = "account"

    static func tabs(provider: String, name: String) -> [ModelPickerTab] {
        [ModelPickerTab(id: ModelPickerTab.favorites, provider: nil, name: "Favorites"),
         ModelPickerTab(id: account, provider: provider, name: name)]
    }

    static func rows(_ list: ThreadModels, provider: String, tab: String, chosen: String?, query: String) -> [ModelPickerRow] {
        let starred = Set(list.favorites)
        let row = { (model: ModelOption) in
            ModelPickerRow(id: model.id, label: model.label, detail: model.detail.isEmpty ? nil : model.detail,
                           chosen: model.id == chosen, starred: starred.contains(model.id), key: provider + "\u{0}" + model.id)
        }
        if ModelSearch.active(query) { return list.models.filter { ModelSearch.matches(query, $0.label) }.map(row) }
        if tab == ModelPickerTab.favorites {
            return list.favorites.compactMap { id in list.models.first { $0.id == id } }.map(row)
        }
        return list.models.map(row)
    }
}
