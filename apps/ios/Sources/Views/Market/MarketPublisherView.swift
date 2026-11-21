import SwiftUI

/// A publisher's public page, read only: their picture, name and mark, what they wrote about
/// themselves, their downloads, the entries they pinned, then everything else they publish.
struct MarketPublisherView: View {
    let model: ClientModel
    let handle: String
    let machineName: String
    @State private var page: MarketPublisherPage?
    @State private var problem: MarketRefusal?
    @State private var refreshes = 0

    init(model: ClientModel, handle: String, machineName: String) {
        self.model = model
        self.handle = handle
        self.machineName = machineName
        _page = State(initialValue: model.keptMarketPublisher(handle))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if let page {
                    MarketStateLine(offline: page.offline).padding(.horizontal, AceDesign.Space.margin)
                    header(page)
                    section("Pinned", page.pinned)
                    section(page.pinned.isEmpty ? "Entries" : "Everything else", page.rows)
                } else if let problem {
                    ProblemRow(problem.message, id: "market.publisher.problem") { Task { await load(fresh: true) } }
                } else {
                    SkeletonRows(count: 4, label: "Reading the publisher")
                }
            }
            .padding(.vertical, AceDesign.Space.related)
        }
        .background(AceDesign.Surface.background)
        .refreshable {
            await load(fresh: true)
            refreshes += 1
        }
        .sensoryFeedback(AceDesign.Haptic.refresh, trigger: refreshes)
        .navigationTitle(page?.name ?? "@\(handle)")
        .navigationBarTitleDisplayMode(.large)
        .marketBrowseActions(model: model, machineName: machineName)
        .task(id: model.marketGeneration) { await load(fresh: false) }
    }

    private func header(_ page: MarketPublisherPage) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            HStack(spacing: AceDesign.Space.row) {
                MarketPictureView(hash: page.avatar, kind: "avatar", size: AceDesign.Size.profileAvatar, round: true) {
                    AceIcon(.user, size: AceDesign.Size.emptyIcon, relativeTo: .title2).foregroundStyle(AceDesign.Ink.muted)
                }
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                    HStack(spacing: AceDesign.Space.tight) {
                        Text("@\(page.handle)").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        if page.verified || page.official {
                            AceIcon(.sealCheck, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                                .foregroundStyle(AceDesign.Ink.action)
                        }
                    }
                    Text(mark(page)).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                }
                .accessibilityElement(children: .combine)
            }
            if !page.bio.isEmpty {
                Text(page.bio).aceFont(AceDesign.TextRole.message).foregroundStyle(AceDesign.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }

    /// "By ace · 12 downloads", "Verified · 12 downloads".
    private func mark(_ page: MarketPublisherPage) -> String {
        let mark = page.official ? "By ace" : page.verified ? "Verified" : nil
        return [mark, page.downloadsText].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder private func section(_ title: String, _ rows: [MarketListing]) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                MarketShelfHeader(title: title).padding(.bottom, AceDesign.Space.tight)
                ForEach(rows) { listing in
                    MarketRow(listing: listing).padding(.horizontal, AceDesign.Space.margin)
                    Divider().padding(.leading, AceDesign.Space.margin)
                }
            }
        }
    }

    private func load(fresh: Bool) async {
        do {
            page = try await model.marketPublisher(handle, fresh: fresh)
            problem = nil
        } catch let refusal as MarketRefusal {
            if !Task.isCancelled { problem = refusal }
        } catch {}
    }
}
