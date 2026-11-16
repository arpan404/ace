import Testing
@testable import Ace

/// The Effort and Speed rows at the top of the model sheet: which levels show, the one selected,
/// the default marked, and why a row can't change, for the thread's model and New thread's.
@Suite struct TuneChoicesTests {
    private func tune(effortReason: String = "", speedReason: String = "", pending: Bool = false, notice: String = "",
                      speeds: [String] = ["standard", "fast"]) -> TuneRow {
        TuneRow(efforts: [.init(id: "low", label: "Low"), .init(id: "medium", label: "Medium"), .init(id: "high", label: "High")],
                effort: "high", effortDefault: false, effortReason: effortReason,
                speeds: speeds.map { .init(speed: $0, label: $0.capitalized) }, speed: "standard", speedReason: speedReason,
                pending: pending, canReset: true, notice: notice, effortPreset: "medium", speedPreset: "standard")
    }
    private let sonnet = ComposeAgent.Model(key: "claude\u{0}sonnet", label: "Sonnet", account: "personal",
                                            efforts: [.init(id: "low", label: "Low"), .init(id: "max", label: "Max")], defaultEffort: "low",
                                            speeds: [.init(speed: "standard", label: "Standard"), .init(speed: "fast", label: "Fast")],
                                            defaultSpeed: "standard")

    @Test func theThreadsLevelsShowInWordsWithTheCurrentSelectedAndTheDefaultMarked() {
        let shown = TuneChoices.thread(tune())
        #expect(shown.effort?.levels.map(\.label) == ["Low", "Medium", "High"])
        #expect(shown.effort?.selected == "high")
        #expect(shown.effort?.levels.filter(\.isDefault).map(\.id) == ["medium"])
        #expect(shown.effort?.reason == nil)
        #expect(shown.speed?.selected == "standard")
        #expect(shown.speed?.levels.filter(\.isDefault).map(\.id) == ["standard"])
    }

    @Test func aRowTheProviderCantChangeNowSaysWhy() {
        let shown = TuneChoices.thread(tune(effortReason: "Claude Code sets effort only when a thread starts"))
        #expect(shown.effort?.reason == "Claude Code sets effort only when a thread starts")
        #expect(shown.speed?.reason == nil)
    }

    @Test func aModelWithOneSpeedHasNoSpeedRow() {
        #expect(TuneChoices.thread(tune(speeds: [])).speed == nil)
        #expect(TuneChoices.thread(tune(speeds: ["standard"])).speed == nil)
    }

    @Test func aPickWaitingForTheNextMessageSaysSoElseTheBridgesNoticeShows() {
        #expect(TuneChoices.thread(tune(pending: true, notice: "Effort reset")).footer == "Applies with your next message.")
        #expect(TuneChoices.thread(tune(notice: "Effort reset for Sonnet")).footer == "Effort reset for Sonnet")
        #expect(TuneChoices.thread(tune()).footer == nil)
    }

    @Test func aModelPickedForANewThreadStartsAtItsOwnDefaults() {
        let shown = TuneChoices.model(sonnet, effort: nil, speed: nil)
        #expect(shown.effort?.levels.map(\.label) == ["Low", "Max"])
        #expect(shown.effort?.selected == "low")
        #expect(shown.speed?.selected == "standard")
        #expect(shown.footer == nil)
    }

    @Test func aLevelAnotherModelHadFallsBackToThisModelsDefault() {
        let shown = TuneChoices.model(sonnet, effort: "high", speed: "ultrafast")
        #expect(shown.effort?.selected == "low")
        #expect(shown.speed?.selected == "standard")
    }

    @Test func aNewThreadShowsItsModelsLevelsAndThePickedOnes() {
        let shown = TuneChoices.model(sonnet, effort: "max", speed: nil)
        #expect(shown.effort?.selected == "max")
        #expect(shown.effort?.levels.filter(\.isDefault).map(\.id) == ["low"])
        #expect(shown.speed?.selected == "standard")
        #expect(shown.effort?.reason == nil)
    }
}
