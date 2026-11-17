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

    private func model(_ efforts: [String], defaultEffort: String? = nil, speeds: [String] = []) -> ComposeAgent.Model {
        ComposeAgent.Model(key: "opencode\u{0}flash", label: "DeepSeek V4.1 Flash", account: "personal",
                           efforts: efforts.map { .init(id: $0, label: $0 == "medium" ? "Medium" : $0.capitalized) },
                           defaultEffort: defaultEffort, speeds: speeds.map { .init(speed: $0, label: $0.capitalized) },
                           defaultSpeed: nil)
    }

    @Test func aNewThreadModelWithOneLevelShowsItFixed() {
        let shown = TuneChoices.model(model(["high"]), effort: nil, speed: nil)
        #expect(shown.effort?.levels.map(\.label) == ["High"])
        #expect(shown.effort?.selected == "high")
        #expect(shown.effort?.reason == "The only level this model has")
        #expect(shown.speed == nil)
    }

    @Test func aNewThreadModelWithNoLevelsSaysSoInsteadOfHidingEffort() {
        let shown = TuneChoices.model(model([]), effort: nil, speed: nil)
        #expect(shown.effort?.levels.isEmpty == true)
        #expect(shown.effort?.reason == "This model has no effort levels")
        #expect(!shown.isEmpty)
    }

    @Test func theModelPillNamesTheEffortTheThreadStartsWith() {
        #expect(TuneChoices.brief(sonnet, effort: nil, speed: nil) == "Low")
        #expect(TuneChoices.brief(model(["low", "medium", "high"], defaultEffort: "medium"), effort: nil, speed: nil) == "Med")
        #expect(TuneChoices.brief(model(["low", "medium", "high"], defaultEffort: "medium"), effort: "high", speed: nil) == "High")
        // A single level, with no default named, is still the one it runs at.
        #expect(TuneChoices.brief(model(["high"]), effort: nil, speed: nil) == "High")
        #expect(TuneChoices.brief(sonnet, effort: "max", speed: "fast") == "Max · Fast")
        #expect(TuneChoices.brief(model([]), effort: nil, speed: nil) == nil)
    }
}
