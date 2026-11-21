import SwiftUI

// A review's sections as `bridge/market-review.ts` writes them (spec item 10): who published it
// and how it is marked, every scan finding with its level, then by type a Suit's checks, a
// plugin's bots, a bot's face, task, model, routines, what it brings and each need, and the
// pages' rows. Nothing here decides; the words come written.

/// One finding of the device's scan: its level (`block`, `warn`, `note`) and its sentence.
struct MarketFinding: Decodable, Equatable, Hashable {
    let level: String
    let levelWord: String
    let sentence: String
}

struct MarketReviewSuit: Decodable, Equatable {
    let passes: Bool
    /// "Passes ace's checks." or where it fails them.
    let checkLine: String
    let problems: [String]
    let scenes: [String]
}

struct MarketReviewPlugin: Decodable, Equatable {
    /// It asks which of Spade's bots may use it.
    let asksBots: Bool
}

struct MarketReviewBot: Decodable, Equatable {
    struct Routine: Decodable, Equatable, Hashable { let name: String; let when: String }
    struct Need: Decodable, Equatable, Identifiable {
        let key: String
        let label: String
        /// Why it asks, then "Required." or "Optional."
        let line: String
        let required: Bool
        /// "Inbox can't work without Gmail." while a required one is off.
        let offSentence: String?
        var id: String { key }
    }
    struct Effect: Decodable, Equatable, Identifiable { let key: String; let words: String; let why: String; var id: String { key } }
    struct Code: Decodable, Equatable, Identifiable { let key: String; let sentence: String; let why: String; var id: String { key } }
    struct Update: Decodable, Equatable {
        let changes: [String]
        let kept: [String]
        let more: [String]
        /// How its kept runs replay on the new version, in a sentence.
        let replay: String?
    }
    let face: SpadeModel.Face
    let task: String
    /// "Fast model" or "Capable model".
    let modelWord: String
    let modelWarning: String?
    let routines: [Routine]
    /// "Skill triage-mail 1.0.0": the skills and plugins it brings.
    let brings: [String]
    let needs: [Need]
    let effects: [Effect]
    let code: [Code]
    /// For an update or rollback: what changes, what stays, what asks for more.
    let update: Update?
}

/// A row of a review's pages: a text shown whole, a file, something it runs, a change or a note.
struct MarketReviewRow: Decodable, Equatable, Identifiable {
    let id: String
    /// `text`, `file`, `run`, `change` or `note`.
    let kind: String
    let section: String
    let title: String
    let text: String?
    let detail: String?
    /// A script, a program or a command: the person should know.
    let flagged: Bool
}

/// Who published it, how it is marked and what it can do.
struct MarketReviewFacts: View {
    let review: MarketReview
    var body: some View {
        QuietSection("What it is") {
            QuietSectionRow {
                QuietRowText(title: review.reviewMark, detail: review.reviewNote,
                             tone: review.reviewNote == nil ? AceDesign.Ink.primary : AceTheme.StatusText.needsYou)
            }
            .accessibilityElement(children: .combine)
            QuietSectionRow { QuietRowText(title: review.signedText, detail: review.publisher.map { "Published by \($0)" }) }
                .accessibilityElement(children: .combine)
            ForEach(review.facts, id: \.self) { fact in
                QuietSectionRow { sentence(fact) }
            }
        }
    }
}

/// What ace's scan on the machine found, each with its level; shown before Install.
struct MarketFindings: View {
    let findings: [MarketFinding]
    var body: some View {
        if !findings.isEmpty {
            QuietSection("What ace's scan found") {
                ForEach(findings, id: \.self) { finding in
                    QuietSectionRow {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(finding.levelWord).aceFont(AceDesign.TextRole.meta).foregroundStyle(tone(finding.level))
                            sentence(finding.sentence)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("market.review.finding")
                }
            }
        }
    }
    private func tone(_ level: String) -> Color {
        switch level {
        case "block": AceTheme.StatusText.failed
        case "warn": AceTheme.StatusText.needsYou
        default: AceDesign.Ink.subtle
        }
    }
}

/// A Suit's check result, what fails, and its scenes.
struct MarketSuitSection: View {
    let suit: MarketReviewSuit
    var body: some View {
        QuietSection("Checks") {
            QuietSectionRow { QuietRowText(title: suit.checkLine, tone: suit.passes ? AceDesign.Ink.primary : AceTheme.StatusText.failed) }
            ForEach(suit.problems, id: \.self) { problem in QuietSectionRow { sentence(problem) } }
            if !suit.scenes.isEmpty {
                QuietSectionRow { QuietRowText(title: "Scenes", detail: suit.scenes.joined(separator: ", ")) }
                    .accessibilityElement(children: .combine)
            }
        }
    }
}

/// A bot's part: face, task and model; for an install its needs, effects and code as switches
/// and its routines with Start its routines (off); for an update what changes and what stays.
struct MarketBotSection: View {
    let bot: MarketReviewBot
    @Binding var state: MarketReviewState
    let disabled: Bool

    var body: some View {
        QuietSection("The bot") {
            QuietSectionRow {
                SpadeFaceView(face: bot.face)
                QuietRowText(title: bot.modelWord, detail: bot.modelWarning)
            }
            .accessibilityElement(children: .combine)
            QuietSectionRow { sentence(bot.task) }
        }
        if let update = bot.update {
            lines("What changes", update.changes)
            lines("Stays because you changed it", update.kept)
            lines("Asks for more", update.more)
            if let replay = update.replay { lines("Your kept runs", [replay]) }
        } else {
            choices
        }
    }

    @ViewBuilder private var choices: some View {
        if !bot.effects.isEmpty {
            QuietSection("What it may do") {
                ForEach(bot.effects) { effect in
                    toggle(effect.words, effect.why, id: "market.review.effect.\(effect.key)",
                           isOn: Binding(get: { state.effect(effect.key) }, set: { state.setEffect(effect.key, $0) }))
                }
            }
        }
        if !bot.code.isEmpty {
            QuietSection("Runs its own code") {
                ForEach(bot.code) { code in
                    toggle(code.sentence, code.why, id: "market.review.code.\(code.key)",
                           isOn: Binding(get: { state.effect(code.key) }, set: { state.setEffect(code.key, $0) }))
                }
            }
        }
        if !bot.needs.isEmpty {
            QuietSection("Apps") {
                ForEach(bot.needs) { need in
                    toggle(need.label, need.line, id: "market.review.need.\(need.key)",
                           isOn: Binding(get: { state.need(need.key) }, set: { state.setNeed(need.key, $0) }))
                }
            }
        }
        if !bot.routines.isEmpty {
            QuietSection("Routines") {
                ForEach(bot.routines, id: \.self) { routine in
                    QuietSectionRow { QuietRowText(title: routine.name, detail: routine.when) }
                        .accessibilityElement(children: .combine)
                }
                toggle("Start its routines", nil, id: "market.review.routines",
                       isOn: Binding(get: { state.choices.startRoutines }, set: { state.choices.startRoutines = $0 }))
            }
        }
        lines("What it brings", bot.brings)
    }

    private func toggle(_ title: String, _ detail: String?, id: String, isOn: Binding<Bool>) -> some View {
        QuietSectionRow {
            Toggle(isOn: isOn) { QuietRowText(title: title, detail: detail) }
                .toggleStyle(.systemSwitch)
                .disabled(disabled)
                .accessibilityIdentifier(id)
        }
    }

    @ViewBuilder private func lines(_ title: String, _ lines: [String]) -> some View {
        if !lines.isEmpty {
            QuietSection(title) { ForEach(lines, id: \.self) { line in QuietSectionRow { sentence(line) } } }
        }
    }
}

/// A plugin's bots: each of Spade's bots on this machine as a switch, all off until chosen.
struct MarketPluginBots: View {
    let model: ClientModel
    @Binding var state: MarketReviewState
    let disabled: Bool
    private var bots: [SpadeModel.Bot] { model.spade.bots?.filter { $0.group == nil && !$0.main } ?? [] }

    var body: some View {
        QuietSection("Bots that get it") {
            if bots.isEmpty {
                QuietSectionRow { sentence(model.spade.bots == nil ? "Spade isn't running, so no bot gets it yet." : "No bots yet. You can allow it for a bot later.") }
            }
            ForEach(bots) { bot in
                QuietSectionRow {
                    Toggle(isOn: Binding(get: { state.allows(bot.id) }, set: { state.setBot(bot.id, $0) })) {
                        HStack(spacing: AceDesign.Space.related) {
                            if let face = bot.faces.first { SpadeFaceView(face: face) }
                            QuietRowText(title: bot.name, detail: bot.line)
                        }
                    }
                    .toggleStyle(.systemSwitch)
                    .disabled(disabled)
                    .accessibilityIdentifier("market.review.bot.\(bot.id)")
                }
            }
        }
    }
}

/// The review's pages: texts shown whole, then what it runs, what changed, its files and notes.
struct MarketReviewRows: View {
    let rows: [MarketReviewRow]
    var body: some View {
        ForEach(rows.filter { $0.kind == "text" }) { row in
            QuietSection(row.title) {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    ScrollView(.horizontal) {
                        Text(verbatim: row.text ?? "").aceMonospace(AceDesign.TextRole.code)
                            .foregroundStyle(AceDesign.Ink.primary).textSelection(.enabled)
                    }
                    if let detail = row.detail { Text(detail).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted) }
                }
                .padding(.horizontal, AceDesign.Space.margin)
            }
        }
        runs
        group("What changed", kind: "change", mono: false)
        group("Files", kind: "file", mono: true)
        ForEach(rows.filter { $0.kind == "note" }) { row in
            QuietSectionRow { sentence(row.title) }
        }
    }

    /// Each hook and server with its whole command and arguments, or a remote server's whole
    /// address: monospaced, wrapping and selectable, never cut, since this is what Install allows.
    @ViewBuilder private var runs: some View {
        let picked = rows.filter { $0.kind == "run" }
        if !picked.isEmpty {
            QuietSection("What it runs") {
                ForEach(picked) { row in
                    QuietSectionRow {
                        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                            Text(row.title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            if let detail = row.detail {
                                Text(verbatim: detail).aceMonospace(AceDesign.TextRole.code)
                                    .foregroundStyle(AceDesign.Ink.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("market.review.run")
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder private func group(_ title: String, kind: String, mono: Bool) -> some View {
        let picked = rows.filter { $0.kind == kind }
        if !picked.isEmpty {
            QuietSection(title) {
                ForEach(picked) { row in
                    QuietSectionRow {
                        QuietRowText(title: row.title, detail: row.detail, mono: mono && kind == "file",
                                     tone: row.flagged && kind == "file" ? AceTheme.StatusText.needsYou : AceDesign.Ink.primary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// A sentence on its own row, wrapping in full.
@MainActor private func sentence(_ text: String) -> some View {
    Text(text).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
}
