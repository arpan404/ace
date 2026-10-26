import Testing
@testable import Ace

@Suite struct ModelPickerRowsTests {
    private func ref(_ model: ComposeAgent.Model) -> ComposeTab.Ref { .init(key: model.key, account: model.account) }
    private let opus = ComposeAgent.Model(key: "claude\u{0}opus", label: "Opus", account: "personal", efforts: [], defaultEffort: nil)
    private let sonnet = ComposeAgent.Model(key: "claude\u{0}sonnet", label: "Sonnet", account: "personal", efforts: [], defaultEffort: nil)
    private let haiku = ComposeAgent.Model(key: "claude\u{0}haiku", label: "Haiku", account: "personal", efforts: [], defaultEffort: nil)
    private let workOpus = ComposeAgent.Model(key: "claude\u{0}opus", label: "Opus", account: "work", efforts: [], defaultEffort: nil)

    private func read(favorites: [ComposeTab.Ref] = [], lead: Int = 3) -> ComposeAgentsRead {
        let agent = ComposeAgent(provider: "claude", name: "Claude Code", ready: true, status: StatusDisplay(label: "Ready", token: "done"),
                                 reason: nil, accounts: [], models: [opus, sonnet, haiku, workOpus], lead: nil)
        return ComposeAgentsRead(state: "ready", agents: [agent], tabs: [
            ComposeTab(id: "favorites", provider: nil, name: "Favorites", reason: nil, models: favorites, lead: favorites.count),
            ComposeTab(id: "claude:personal", provider: "claude", name: "Claude Code · Personal", reason: nil,
                       models: [opus, sonnet, haiku].map(ref), lead: lead),
            ComposeTab(id: "claude:work", provider: "claude", name: "Claude Code · Work", reason: "Limit reached",
                       models: [ref(workOpus)], lead: 1),
        ], favorites: favorites.map(\.key))
    }
    private let onWork = NewThreadPickerRows.Chosen(provider: "claude", key: "claude\u{0}opus", account: "work")

    @Test func theSheetOpensOnFavoritesOnlyWhenSomethingIsStarred() {
        let starred = read(favorites: [ref(sonnet)])
        #expect(ModelPickerStart.tab(NewThreadPickerRows.tabs(starred), hasFavorites: true, current: "claude:work") == "favorites")
        #expect(ModelPickerStart.tab(NewThreadPickerRows.tabs(read()), hasFavorites: false, current: "claude:work") == "claude:work")
        #expect(ModelPickerStart.tab(NewThreadPickerRows.tabs(read()), hasFavorites: false, current: nil) == "claude:personal")
    }
    @Test func anAccountTabListsOnlyItsAccountsModelsAndChecksTheModelInUseOnlyThere() {
        let personal = NewThreadPickerRows.rows(read(), tab: "claude:personal", chosen: onWork, query: "", expanded: false)
        #expect(personal.rows.map(\.label) == ["Opus", "Sonnet", "Haiku"])
        #expect(personal.rows.allSatisfy { !$0.chosen })
        let work = NewThreadPickerRows.rows(read(), tab: "claude:work", chosen: onWork, query: "", expanded: false)
        #expect(work.rows.map(\.chosen) == [true])
    }
    @Test func favoritesNameTheAccountEachRunsOnAndKeepTheCheckOnTheModelInUse() {
        let rows = NewThreadPickerRows.rows(read(favorites: [ref(workOpus), ref(sonnet)]), tab: "favorites", chosen: onWork,
                                            query: "", expanded: false).rows
        #expect(rows.map(\.label) == ["Opus", "Sonnet"])
        #expect(rows.map(\.detail) == ["Claude Code · Work", "Claude Code · Personal"])
        #expect(rows.map(\.chosen) == [true, false])
        #expect(rows.allSatisfy { $0.starred })
    }
    @Test func aLongTabShowsItsLeadUntilMoreModelsOpens() {
        let shut = NewThreadPickerRows.rows(read(lead: 1), tab: "claude:personal", chosen: nil, query: "", expanded: false)
        #expect(shut.rows.map(\.label) == ["Opus"])
        #expect(shut.hidden == 2)
        let open = NewThreadPickerRows.rows(read(lead: 1), tab: "claude:personal", chosen: nil, query: "", expanded: true)
        #expect(open.rows.count == 3 && open.hidden == 0)
    }
    @Test func aSearchLooksThroughEveryAccountAndNamesEach() {
        let found = NewThreadPickerRows.rows(read(lead: 1), tab: "favorites", chosen: nil, query: "opus", expanded: false).rows
        #expect(found.map(\.detail) == ["Claude Code · Personal", "Claude Code · Work"])
    }
    @Test func theThreadSheetsFavoritesFollowTheStarOrderAndItsCheckFollowsThePick() {
        var list = ThreadModels()
        list.models = [ModelOption(id: "a", label: "A", detail: "", current: true), ModelOption(id: "b", label: "B", detail: "", current: false)]
        list.favorites = ["b", "a"]
        let favorites = ThreadPickerRows.rows(list, provider: "codex", tab: "favorites", chosen: "b", query: "")
        #expect(favorites.map(\.label) == ["B", "A"])
        #expect(favorites.map(\.chosen) == [true, false])
        #expect(favorites.first?.key == "codex\u{0}b")
        #expect(ThreadPickerRows.rows(list, provider: "codex", tab: ThreadPickerRows.account, chosen: "a", query: "").map(\.label) == ["A", "B"])
    }
}
