import SwiftUI

/// The review before an install or an update (spec items 9 to 14), as a sheet titled "Get
/// <title>" at a medium detent that grows to large. It is prepared on the machine; the scan's
/// findings and what it may do come first, then its switches and its pages. The first page is
/// fetched at once and each later one when the end of the one before is in view (at once again
/// when a short page leaves it in view); loading rows show only while one is being read. Install stays off until they have
/// scrolled to the end of the last. Dismissed without installing, the review is cancelled on
/// the machine, even one whose prepare was still under way. `done` gets what landed.
struct MarketReviewSheet: View {
    enum Mode: Hashable {
        /// Get: a listed entry onto this machine.
        case install(MarketEntryKey)
        /// Update an installed entry (a bot made from a package, by its bot).
        case update(MarketInstalledKey)
    }
    let model: ClientModel
    let mode: Mode
    let machineName: String
    let done: (MarketInstall?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var state = MarketReviewState()
    @State private var preparing = false
    /// The end of the content is in view above the foot, as the scroll last reported it.
    @State private var endInView = false
    /// Outlives the sheet: a prepare that lands after dismissal is cancelled at once.
    @State private var lease = MarketReviewLease()

    private var online: Bool { model.connection == "ready" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let review = state.review {
                        header(review)
                        MarketFindings(findings: review.findings)
                        MarketReviewFacts(review: review)
                        if let suit = review.suit { MarketSuitSection(suit: suit) }
                        if let bot = review.bot { MarketBotSection(bot: bot, state: $state, disabled: state.installing) }
                        if review.plugin?.asksBots == true { MarketPluginBots(model: model, state: $state, disabled: state.installing) }
                        MarketReviewRows(rows: state.rows)
                        if state.loadingMore {
                            SkeletonRows(count: 2, label: "Reading more of the review")
                        }
                    } else if preparing {
                        SkeletonRows(count: 4, label: "Reading the review")
                    }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
            }
            .background(AceDesign.Surface.background)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { foot }
            // Where the person has scrolled, not what has rendered: the end counts only once it
            // is in view above the foot, with every row shown so far. `shown` is the rows this
            // layout drew, read where the geometry is, so rows still arriving never count as seen.
            .onScrollGeometryChange(for: ReviewScrollEnd.self) { [shown = state.rows.count] geometry in
                ReviewScrollEnd(atEnd: MarketReviewState.atEnd(offsetY: geometry.contentOffset.y,
                                                         containerHeight: geometry.containerSize.height,
                                                         insetBottom: geometry.contentInsets.bottom,
                                                         contentHeight: geometry.contentSize.height),
                          height: geometry.contentSize.height, shown: shown)
            } action: { _, end in
                endInView = end.atEnd
                if end.atEnd { reachedEnd(shown: end.shown) }
            }
            .navigationTitle(state.review?.heading ?? "Review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(state.installing).accessibilityIdentifier("market.review.cancel")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(state.installing)
        // Not `.task`: a prepare must finish after dismissal so its review can be cancelled.
        .onAppear { if !lease.started { lease.started = true; Task { await prepare() } } }
        .onDisappear { lease.close(model) }
        .accessibilityIdentifier("market.review.sheet")
    }

    private func header(_ review: MarketReview) -> some View {
        HStack(spacing: AceDesign.Space.row) {
            if let face = review.bot?.face {
                SpadeFaceView(face: face, size: AceDesign.Size.tap)
            } else {
                AceIcon(.store, size: AceDesign.Size.barIcon, relativeTo: .title3).foregroundStyle(AceDesign.Ink.muted)
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(review.title).aceFont(AceDesign.TextRole.header).foregroundStyle(AceDesign.Ink.primary)
                Text(review.byLine).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .accessibilityElement(children: .combine)
    }

    /// The scroll reached the end of what the page shows: it counts as seen, and the next page,
    /// if any, is fetched.
    private func reachedEnd(shown: Int) {
        guard let review = state.review else { return }
        state.reachedEnd(of: review.id, shown: shown)
        readNext(endInView: true)
    }

    /// Reads the next page if one is due (`MarketReviewState.beginRead`).
    private func readNext(endInView: Bool) {
        guard let review = state.review, let offset = state.beginRead(endInView: endInView) else { return }
        Task { await readPage(review, from: offset) }
    }

    /// Install, what stops it, or what went wrong, always in view at the sheet's foot.
    private var foot: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if state.exhausted, let refusal = state.refusal {
                // The one retry was refused: the sentence stays, and nothing more is sent from here.
                ProblemRow(refusal.message, id: "market.review.problem")
                    .padding(.horizontal, -AceDesign.Space.margin)
            } else if state.needsPerson, let refusal = state.refusal {
                MarketConfirmPerson(refusal: refusal, hostId: model.hostId, busy: state.installing || !online,
                                    close: { dismiss() }) {
                    if let review = state.review { install(review, confirmed: true) }
                }
            } else if state.needsComputer, let line = state.review?.standingSentence {
                Text(line).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceTheme.StatusText.needsYou)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("market.review.computer")
            } else if let refusal = state.refusal {
                ProblemRow(refusal.message, id: "market.review.problem", retryLabel: wayLabel(refusal.way),
                           disabled: preparing || state.installing, retry: way(refusal.way))
                    .padding(.horizontal, -AceDesign.Space.margin)
            } else if let stuck = state.stuck {
                Text(stuck).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceTheme.StatusText.failed)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("market.review.stuck")
            } else if !online {
                Text("Your machine is offline.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            } else if state.review != nil, !state.complete || !state.seenEnd {
                Text("Scroll to the end to install.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            if let review = state.review, review.blocked == nil {
                Button { install(review) } label: {
                    Text(state.installing ? review.pendingWord : review.action).frame(maxWidth: .infinity)
                }
                .buttonStyle(.primaryAction).controlSize(.large)
                .disabled(!state.canInstall || !online)
                .accessibilityIdentifier("market.review.install")
                Text("Installs on \(machineName).").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.related)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AceDesign.Surface.background)
    }

    private func wayLabel(_ way: MarketWay?) -> String {
        way == .reread ? "Review it again" : "Try again"
    }
    private func way(_ way: MarketWay?) -> (() -> Void)? {
        switch way {
        case .reread: return { Task { await prepare() } }
        case .retry:
            // Whatever failed runs again: the prepare, the page, or Install.
            guard let review = state.review else { return { Task { await prepare() } } }
            if state.complete { return { install(review) } }
            return {
                guard let offset = state.retryRead() else { return }
                Task { await readPage(review, from: offset) }
            }
        default: return nil
        }
    }

    private func prepare() async {
        guard !preparing else { return }
        preparing = true
        defer { preparing = false }
        do {
            let review: MarketReview
            switch mode {
            case .install(let key): review = try await model.marketPrepare(key)
            case .update(let key): review = try await model.marketPrepareUpdate(key)
            }
            // Closed while it was being prepared: the machine shouldn't hold it until it expires.
            guard lease.hold(review, model) else { return }
            state.opened(review)
            readNext(endInView: endInView)
        } catch let refusal as MarketRefusal {
            state.refused(refusal)
        } catch {}
    }

    private func readPage(_ review: MarketReview, from offset: Int) async {
        do {
            state.read(try await model.marketReviewPage(review.id, offset: offset), from: offset)
        } catch let refusal as MarketRefusal {
            state.refused(refusal)
            return
        } catch {
            // Said with Retry, like any refusal, so the page waits for the person.
            state.refused(MarketRefusal(code: "failed", message: "Part of the review didn't load.", way: .retry, offline: false))
            return
        }
        state.readEnded()
        // A page that landed and left the end in view: the scroll won't move to say so, so the
        // next one is read now. Only after a page landed, so a failing read never repeats itself.
        if state.nextOffset != offset { readNext(endInView: endInView) }
    }

    private func install(_ review: MarketReview, confirmed: Bool = false) {
        guard confirmed ? state.canConfirm : state.canInstall else { return }
        state.started(confirmed: confirmed)
        Task {
            do {
                let landed = try await model.marketInstall(review, choices: state.choices.payload, confirmed: confirmed)
                lease.installed()
                state.finished()
                // Played here, not by a trigger: the sheet closes in the same moment.
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                done(landed)
                dismiss()
            } catch let refusal as MarketRefusal {
                state.refused(refusal)
            } catch {
                state.refused(MarketRefusal(code: "failed", message: "The install didn't finish, and nothing was installed.", way: .retry, offline: false))
            }
        }
    }
}

/// Whether the content's end is in view, and how tall the content is: rows arriving change the
/// height, so they are reported even while the end stays in view, and count as seen only then.
/// `shown` is how many rows the layout measured had drawn.
private struct ReviewScrollEnd: Equatable {
    let atEnd: Bool
    let height: CGFloat
    let shown: Int
}

/// The review this sheet holds on the machine, kept by reference so it outlives the sheet: closed
/// with a prepare still under way, the review that lands is cancelled as soon as its id arrives.
@MainActor private final class MarketReviewLease {
    var started = false
    private var closed = false
    private var held: MarketReview?

    /// Takes the prepared review; false, having cancelled it, when the sheet already closed.
    func hold(_ review: MarketReview, _ model: ClientModel) -> Bool {
        guard !closed else {
            Task { try? await model.marketCancel(review) }
            return false
        }
        // A review read again replaces the dropped one, which the machine no longer holds.
        held = review
        return true
    }

    func installed() { held = nil }

    /// The sheet went: the review it holds, if any, is cancelled.
    func close(_ model: ClientModel) {
        closed = true
        if let review = held { Task { try? await model.marketCancel(review) } }
        held = nil
    }
}
