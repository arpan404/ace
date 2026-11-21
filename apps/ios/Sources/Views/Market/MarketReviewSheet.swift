import SwiftUI

/// The review before an install or an update (spec items 9 to 14), as a sheet titled "Get
/// <title>" at a medium detent that grows to large. It is prepared on the machine; the scan's
/// findings and what it may do come first, then its switches and its pages, and Install stays
/// off until the person has read to the end. Dismissed without installing, the review is
/// cancelled on the machine. `done` gets what landed.
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
    @State private var installed = false

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
                        if state.nextOffset != nil { readMore(review) }
                    } else if preparing {
                        SkeletonRows(count: 4, label: "Reading the review")
                    }
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
            }
            .background(AceDesign.Surface.background)
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { foot }
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
        .task { await prepare() }
        .onDisappear {
            if let review = state.review, !installed { Task { try? await model.marketCancel(review) } }
        }
        .accessibilityIdentifier("market.review.sheet")
    }

    private func header(_ review: MarketReview) -> some View {
        HStack(spacing: AceDesign.Space.row) {
            if let face = review.bot?.face {
                SpadeFaceView(face: face, size: AceDesign.Size.tap)
            } else {
                AceIcon(.storefront, size: AceDesign.Size.barIcon, relativeTo: .title3).foregroundStyle(AceDesign.Ink.muted)
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

    /// The end of what is read so far: reaching it reads the next page.
    private func readMore(_ review: MarketReview) -> some View {
        SkeletonRows(count: 2, label: "Reading more of the review")
            .task(id: state.nextOffset) { await readPage(review) }
    }

    /// Install, what stops it, or what went wrong, always in view at the sheet's foot.
    private var foot: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if state.needsComputer, let line = state.review?.standingSentence {
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
            } else if state.review != nil, !state.complete {
                Text("Read to the end to install.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
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
            return { Task { await readPage(review) } }
        default: return nil
        }
    }

    private func prepare() async {
        guard !preparing else { return }
        preparing = true
        defer { preparing = false }
        do {
            switch mode {
            case .install(let key): state.opened(try await model.marketPrepare(key))
            case .update(let key): state.opened(try await model.marketPrepareUpdate(key))
            }
        } catch let refusal as MarketRefusal {
            state.refused(refusal)
        } catch {}
    }

    private func readPage(_ review: MarketReview) async {
        guard let offset = state.nextOffset else { return }
        do {
            state.read(try await model.marketReviewPage(review.id, offset: offset), from: offset)
        } catch let refusal as MarketRefusal {
            state.refused(refusal)
        } catch {}
    }

    private func install(_ review: MarketReview) {
        guard state.canInstall else { return }
        state.started()
        Task {
            do {
                let landed = try await model.marketInstall(review, choices: state.choices.payload)
                installed = true
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
