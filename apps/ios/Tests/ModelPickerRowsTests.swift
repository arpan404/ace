import Testing
@testable import Ace

@Suite struct ModelPickerRowsTests {
    private func model(_ label: String, account: String = "cli") -> ComposeAgent.Model {
        .init(key: label, label: label, account: account, efforts: [], defaultEffort: nil)
    }
    private func agent(_ models: [ComposeAgent.Model], accounts: [ComposeAgent.Account] = [], lead: Int? = nil) -> ComposeAgent {
        ComposeAgent(provider: "claude", name: "Claude Code", ready: true, status: StatusDisplay(label: "Ready", token: "done"),
                     reason: nil, accounts: accounts, models: models, lead: lead)
    }
    private func labels(_ groups: [ModelPickerGroup]) -> [[String]] { groups.map { $0.rows.map(\.label) } }

    @Test func modelsKeepTheBridgeOrderAndOnlyTheChosenOneIsChecked() {
        let claude = agent([model("Opus"), model("Sonnet"), model("Haiku")])
        let groups = NewThreadPickerRows.groups(claude, chosen: .init(provider: "claude", key: "Sonnet", account: "cli"), query: "", expanded: false)
        #expect(labels(groups) == [["Opus", "Sonnet", "Haiku"]])
        #expect(groups.flatMap(\.rows).filter(\.chosen).map(\.label) == ["Sonnet"])
        #expect(groups.first?.title == nil)
    }
    @Test func theSameModelOnAnotherProviderIsNotChecked() {
        let claude = agent([model("Opus")])
        let groups = NewThreadPickerRows.groups(claude, chosen: .init(provider: "codex", key: "Opus", account: "cli"), query: "", expanded: false)
        #expect(groups.flatMap(\.rows).allSatisfy { !$0.chosen })
    }
    @Test func aLongListShowsItsLeadUntilMoreModelsOpens() {
        let claude = agent(["A", "B", "C", "D", "E", "F"].map { model($0) }, lead: 4)
        #expect(labels(NewThreadPickerRows.groups(claude, chosen: nil, query: "", expanded: false)) == [["A", "B", "C", "D"]])
        #expect(NewThreadPickerRows.hidden(claude, query: "", expanded: false) == 2)
        #expect(labels(NewThreadPickerRows.groups(claude, chosen: nil, query: "", expanded: true)) == [["A", "B", "C", "D", "E", "F"]])
        #expect(NewThreadPickerRows.hidden(claude, query: "", expanded: true) == 0)
    }
    @Test func searchingLooksThroughEveryModelOfTheProvider() {
        let claude = agent([model("Opus 5.5"), model("Sonnet"), model("Opus 4")], lead: 1)
        #expect(labels(NewThreadPickerRows.groups(claude, chosen: nil, query: "opus", expanded: false)) == [["Opus 5.5", "Opus 4"]])
        #expect(NewThreadPickerRows.hidden(claude, query: "opus", expanded: false) == 0)
    }
    @Test func severalAccountsEachGetAHeadingWithTheirUsage() {
        let accounts = [ComposeAgent.Account(id: "personal", label: "Personal", usage: "62% used"),
                        ComposeAgent.Account(id: "work", label: "Work", usage: "")]
        let claude = agent([model("Opus", account: "personal"), model("Opus", account: "work"), model("Sonnet", account: "personal")], accounts: accounts)
        let groups = NewThreadPickerRows.groups(claude, chosen: .init(provider: "claude", key: "Opus", account: "work"), query: "", expanded: false)
        #expect(groups.map(\.title) == ["Personal", "Work"])
        #expect(groups.map(\.value) == ["62% used", nil])
        #expect(labels(groups) == [["Opus", "Sonnet"], ["Opus"]])
        #expect(groups[1].rows.first?.chosen == true && groups[0].rows.first?.chosen == false)
    }
}
