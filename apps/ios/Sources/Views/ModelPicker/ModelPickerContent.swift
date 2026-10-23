import Foundation

/// A provider the picker can switch to: New thread only, since a thread keeps its provider.
/// `note` says in words why it can't start a thread; nil when it can.
struct ModelPickerProvider: Identifiable, Equatable {
    let id: String
    let name: String
    var note: String? = nil
}

/// One model the picker lists, with a muted line only when it says something.
struct ModelPickerRow: Identifiable, Equatable {
    let id: String
    let label: String
    var detail: String? = nil
    let chosen: Bool
}

/// The shown provider's models under one heading: an account when the provider has more than
/// one, else none. `value` is that account's usage.
struct ModelPickerGroup: Identifiable, Equatable {
    let id: String
    var title: String? = nil
    var value: String? = nil
    let rows: [ModelPickerRow]
}

/// Whether a model's name matches what was typed into "Find a model".
enum ModelSearch {
    static func matches(_ query: String, _ words: String...) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || words.contains { $0.localizedCaseInsensitiveContains(needle) }
    }
}

/// New thread's picker rows for one coding agent, in the bridge's order (`newThreadModelList`):
/// the lead rows until "More models" opens or a search runs, then grouped by account when the
/// agent has several, in the bridge's account order.
enum NewThreadPickerRows {
    struct Chosen: Equatable { let provider: String; let key: String; let account: String }

    static func groups(_ agent: ComposeAgent, chosen: Chosen?, query: String, expanded: Bool) -> [ModelPickerGroup] {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let models = (searching || expanded ? Array(agent.models) : Array(agent.leading))
            .filter { ModelSearch.matches(query, $0.label) }
        let row = { (model: ComposeAgent.Model) in
            ModelPickerRow(id: model.id, label: model.label,
                           chosen: chosen == Chosen(provider: agent.provider, key: model.key, account: model.account))
        }
        guard agent.accounts.count > 1 else {
            return models.isEmpty ? [] : [ModelPickerGroup(id: agent.provider, rows: models.map(row))]
        }
        let known = Set(agent.accounts.map(\.id))
        var groups = agent.accounts.compactMap { account -> ModelPickerGroup? in
            let own = models.filter { $0.account == account.id }
            guard !own.isEmpty else { return nil }
            return ModelPickerGroup(id: account.id, title: account.label, value: account.usage.isEmpty ? nil : account.usage, rows: own.map(row))
        }
        let unlisted = models.filter { !known.contains($0.account) }
        if !unlisted.isEmpty { groups.append(ModelPickerGroup(id: agent.provider, rows: unlisted.map(row))) }
        return groups
    }

    /// How many more models "More models" would show; zero while searching or open.
    static func hidden(_ agent: ComposeAgent, query: String, expanded: Bool) -> Int {
        expanded || !query.trimmingCharacters(in: .whitespaces).isEmpty ? 0 : agent.more.count
    }
}
