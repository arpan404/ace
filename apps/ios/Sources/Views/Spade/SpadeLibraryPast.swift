import SwiftUI

/// Past work: the goals the bot closed, newest first, each with the line saying what it came
/// to; the first few, then Show all. Each opens to read.
struct SpadeLibraryPast: View {
    let scope: SpadeProfileScope
    /// Rows shown before Show all.
    static let shown = 5
    @State private var answer: SpadeLibraryAnswer?
    @State private var all = false

    var body: some View {
        Section {
            if let answer {
                if let problem = answer.problem {
                    ProblemRow(problem, id: "spade.library.past.problem") { Task { await load() } }
                } else {
                    let rows = answer.episodes ?? []
                    if rows.isEmpty { SpadeProfileNone(text: "Each goal \(scope.name) finishes is kept here.") }
                    ForEach(all ? rows : Array(rows.prefix(Self.shown))) { SpadeLibraryRowView(scope: scope, row: $0) }
                    if rows.count > Self.shown {
                        Button(all ? "Show fewer" : "Show all \(rows.count + (answer.more ?? 0))") {
                            withAnimation { all.toggle() }
                        }
                        .foregroundStyle(AceDesign.Ink.action)
                        .accessibilityIdentifier("spade.library.past.all")
                    }
                    if all, let more = answer.more, more > 0 { SpadeProfileNone(text: "\(more) more on the computer") }
                }
            } else {
                SkeletonRows(count: 2, label: "Reading the past work").listRowInsets(EdgeInsets())
            }
        } header: {
            Text("Past work")
        }
        .task(id: scope.agent) { await load() }
    }

    private func load() async {
        let read = await scope.client.spadeLibraryPast(scope.agent)
        // A read that failed keeps the list already shown.
        if read.ok || answer?.ok != true { answer = read }
    }
}

/// A piece of past work, to read: the goal in its words, when it ran, how it closed and what it
/// cost, then what it had to meet, what worked, what didn't and why, what was still missing, and
/// the bot's own last word on it.
struct SpadeEpisodeView: View {
    let scope: SpadeProfileScope
    let id: String
    @State private var answer: SpadeLibraryAnswer?

    var body: some View {
        List {
            if let episode = answer?.episode {
                page(episode)
            } else if let problem = answer?.problem {
                ProblemRow(problem, id: "spade.episode.problem") { Task { await load() } }
            } else {
                SkeletonRows(count: 3, label: "Reading it").listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(answer?.episode?.title ?? "Past work")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder private func page(_ episode: SpadeEpisodePage) -> some View {
        Section {
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                Text(episode.title)
                    .aceFont(AceDesign.TextRole.header)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .accessibilityAddTraits(.isHeader)
                Text(meta(episode)).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                if !episode.text.isEmpty {
                    Text(episode.text).aceFont(AceDesign.TextRole.message).foregroundStyle(AceDesign.Ink.primary)
                }
            }
            .accessibilityElement(children: .combine)
        }
        if !episode.criteria.isEmpty {
            Section("Done when") {
                ForEach(episode.criteria, id: \.self) { criterion in
                    HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.groupGlyphGap) {
                        Group {
                            switch criterion.met {
                            case true: AceIcon(.check, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline)
                            case false: AceIcon(.x, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline)
                            default: Color.clear.frame(width: AceDesign.Size.groupGlyph, height: AceDesign.Size.groupGlyph)
                            }
                        }
                        .foregroundStyle(AceDesign.Ink.muted)
                        Text(criterion.text).aceFont(AceDesign.TextRole.message)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityValue(criterion.met == true ? "Met" : criterion.met == false ? "Not met" : "")
                }
            }
        }
        lines("Worked", episode.worked)
        lines("Didn't work", episode.failed)
        lines("Still missing", episode.missing)
        if let note = episode.note {
            Section("In \(possessive(scope.name)) words") {
                Text(note).aceFont(AceDesign.TextRole.message).foregroundStyle(AceDesign.Ink.muted)
            }
        }
    }

    @ViewBuilder private func lines(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            Section(title) {
                ForEach(Array(items.enumerated()), id: \.offset) { Text($0.element).aceFont(AceDesign.TextRole.message) }
            }
        }
    }

    /// "Nov 19, 10:20 AM – 1:48 PM · Done and checked · $0.12 · Untrusted".
    private func meta(_ episode: SpadeEpisodePage) -> String {
        let from = Date(timeIntervalSince1970: episode.startedAt / 1000)
        let to = Date(timeIntervalSince1970: episode.closedAt / 1000)
        var parts = [(from..<max(from, to)).formatted(.interval.month(.abbreviated).day().hour().minute()), episode.outcome]
        if let cost = episode.cost { parts.append(cost) }
        if episode.untrusted { parts.append("Untrusted") }
        return parts.joined(separator: " · ")
    }

    private func possessive(_ name: String) -> String {
        name.lowercased().hasSuffix("s") ? "\(name)'" : "\(name)'s"
    }

    private func load() async {
        answer = await scope.client.spadeLibraryEpisode(id)
    }
}
