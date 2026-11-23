import SwiftUI

/// Publishing a bot, skill or plugin from the phone (#2548), as a sheet: what kind, which one,
/// what it would upload, ace's checks on its files, its listing, then Submit. Each step pushes
/// onto the sheet's own stack, so Back is the system's. Opened from Your listings, or from a
/// bot's profile on that bot (`bot`), which starts at its review.
struct MarketPublishView: View {
    let model: ClientModel
    /// A Spade bot's id, to publish that bot.
    var bot: String? = nil
    /// Something was published: Your listings reads itself again.
    var published: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var flow = MarketPublishFlow()

    var body: some View {
        NavigationStack(path: $flow.path) {
            Group {
                if bot != nil {
                    MarketPublishPick(model: model, type: "spade-bot", flow: flow, bot: bot)
                } else {
                    kinds
                }
            }
            .navigationDestination(for: MarketPublishStep.self) { step in
                switch step {
                case .pick(let type): MarketPublishPick(model: model, type: type, flow: flow)
                case .review: MarketPublishReview(model: model, flow: flow)
                case .checks: MarketPublishChecks(flow: flow)
                case .describe: MarketPublishDescribe(model: model, flow: flow, close: { dismiss() })
                case .done: MarketPublishDone(flow: flow) { dismiss() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(flow.working).accessibilityIdentifier("market.publish.cancel")
                }
            }
        }
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(flow.working)
        .onChange(of: flow.path) { _, path in if path.last == .done { published() } }
    }

    /// The first step: what kind of thing is published.
    private var kinds: some View {
        List {
            Section {
                ForEach(MarketPublishKind.all) { kind in
                    Button { flow.path.append(.pick(kind.type)) } label: {
                        InsetRow(kind.title, icon: kind.icon, subtitle: kind.line)
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("market.publish.kind.\(kind.type)")
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Publish")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The kinds the phone publishes. A Suit is made and published on the computer.
struct MarketPublishKind: Identifiable {
    let type: String
    let title: String
    let line: String
    let icon: AceIcon.Name
    var id: String { type }

    static let all = [
        MarketPublishKind(type: "spade-bot", title: "Bot", line: "Its face, task, routines and the apps it needs.", icon: .robot),
        MarketPublishKind(type: "spade-skill", title: "Skill", line: "Instructions and scripts a bot can use.", icon: .lightning),
        MarketPublishKind(type: "spade-plugin", title: "Plugin", line: "Commands and tools for agents and bots.", icon: .puzzlePiece),
    ]
    static func title(_ type: String) -> String { all.first { $0.type == type }?.title ?? "Item" }
}

enum MarketPublishStep: Hashable {
    case pick(String)
    case review
    case checks
    case describe
    case done
}

/// What the person has chosen so far, shared by every step of one publish.
@Observable @MainActor final class MarketPublishFlow {
    var path: [MarketPublishStep] = []
    var item: MarketPublishable?
    var check: MarketPublishCheck?
    /// Binary files the person ticked to upload.
    var binaries: Set<String> = []
    /// A bot's routines kept, by index.
    var routines: Set<Int> = []
    var draft: MarketPublishDraft?
    var listing = MarketListingWords()
    var notes = ""
    /// The pictures picked from Photos, as JPEG.
    var pictures: [MarketPublishPicture] = []
    var published: MarketPublished?
    /// A draft or the submit is under way: the sheet stays.
    var working = false

    /// `item` picked: what was read for an earlier pick goes.
    func choose(_ picked: MarketPublishable) {
        if item?.id != picked.id {
            check = nil
            draft = nil
            binaries = []
            routines = []
            listing = MarketListingWords(title: picked.title, line: picked.line)
        }
        item = picked
    }
}

/// The Item step: the person's own things of one kind, with where each stands in the market.
struct MarketPublishPick: View {
    let model: ClientModel
    let type: String
    let flow: MarketPublishFlow
    /// Opens this bot's review as soon as it is found.
    var bot: String? = nil
    @State private var page: MarketPublishables?
    @State private var problem: MarketRefusal?

    var body: some View {
        List {
            if let problem {
                Section { ProblemRow(problem.message, detail: problem.reason, id: "market.publish.pick.problem") { Task { await load() } } }
                    .insetRowBackground()
            }
            if let page {
                if page.items.isEmpty {
                    EmptyState(icon: .package, title: "Nothing to publish yet",
                               line: "Make a \(MarketPublishKind.title(type).lowercased()) first, then publish it here.")
                        .frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(page.items) { item in
                            Button { open(item) } label: {
                                InsetRow(item.title, icon: nil, subtitle: "\(item.fromText) · \(item.state)")
                            }
                            .buttonStyle(.row)
                            .accessibilityIdentifier("market.publish.item.\(item.name)")
                        }
                    } footer: {
                        if !page.unavailable.isEmpty { Text(page.unavailable.joined(separator: " ")) }
                    }
                    .insetRowBackground()
                }
            } else if problem == nil {
                Section { SkeletonRows(count: 3, label: "Reading what you can publish").listRowInsets(EdgeInsets()) }
            }
        }
        .insetGroupedList()
        .navigationTitle("Which \(MarketPublishKind.title(type).lowercased())?")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func open(_ item: MarketPublishable) {
        flow.choose(item)
        flow.path.append(.review)
    }

    private func load() async {
        do {
            let read = try await model.marketPublishables(type)
            page = read
            problem = nil
            if let bot, flow.path.isEmpty, let mine = read.items.first(where: { $0.bot == bot }) { open(mine) }
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}

/// The last step: it's in, waiting for review.
struct MarketPublishDone: View {
    let flow: MarketPublishFlow
    let close: () -> Void

    var body: some View {
        VStack(spacing: AceDesign.Space.related) {
            if let published = flow.published {
                AceIcon(.checkCircle, size: AceDesign.Size.spade, relativeTo: .largeTitle)
                    .foregroundStyle(AceTheme.StatusText.done)
                    .accessibilityHidden(true)
                Text(published.title).aceFont(AceDesign.TextRole.header).foregroundStyle(AceDesign.Ink.primary)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(published.line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .multilineTextAlignment(.center)
                if let problem = published.listingProblem {
                    Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.needsYou)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("market.publish.listingProblem")
                }
                Button("Done", action: close).buttonStyle(.primaryAction)
                    .padding(.top, AceDesign.Space.related)
                    .accessibilityIdentifier("market.publish.done")
            }
        }
        .padding(AceDesign.Space.margin)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AceDesign.Surface.background)
        .navigationBarBackButtonHidden()
        .navigationBarTitleDisplayMode(.inline)
    }
}
