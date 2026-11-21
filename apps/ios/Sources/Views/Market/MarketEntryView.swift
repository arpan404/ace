import SwiftUI

/// An entry's page (spec items 8, 13 to 16): its picture or face, title, one line and publisher
/// with its mark, then the one action (Get, Update, Installed, or why it can't), what it may do,
/// its review mark, versions, downloads and source. Get and Update open the review sheet; an
/// installed entry offers Remove, which asks first, and a withdrawn one Turn back on. It reads
/// again when the market changes.
struct MarketEntryView: View {
    let model: ClientModel
    let entry: MarketEntryKey
    /// The machine it installs onto, by name ("Install on arpan-mbp").
    let machineName: String
    @State private var page: MarketEntryPage?
    @State private var problem: MarketRefusal?
    /// What it may do and its face, from a review read once for the page and cancelled at once.
    @State private var canDo: [String] = []
    @State private var face: SpadeModel.Face?
    @State private var picture: UIImage?
    @State private var reviewing: Ask?
    @State private var removing = false
    @State private var busy = false
    @State private var changeProblem: String?
    @State private var removed = 0

    private struct Ask: Identifiable {
        let mode: MarketReviewSheet.Mode
        var id: MarketReviewSheet.Mode { mode }
    }

    init(model: ClientModel, entry: MarketEntryKey, machineName: String) {
        self.model = model
        self.entry = entry
        self.machineName = machineName
        _page = State(initialValue: model.keptMarketEntry(entry))
    }

    private var online: Bool { model.connection == "ready" && page?.offline != true }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if let detail = page?.entry {
                    header(detail)
                    if let changeProblem { ProblemRow(changeProblem, id: "market.entry.problem") }
                    if !canDo.isEmpty {
                        QuietSection("What it may do") {
                            ForEach(canDo, id: \.self) { line in QuietSectionRow { words(line) } }
                        }
                    }
                    if !detail.description.isEmpty, detail.description != detail.line {
                        QuietSection("About") { QuietSectionRow { words(detail.description) } }
                    }
                    information(detail)
                    if !detail.versions.isEmpty { versions(detail) }
                } else if let problem {
                    ProblemRow(problem.message, id: "market.entry.problem", retry: { Task { await load() } })
                } else {
                    SkeletonRows(count: 4, label: "Reading the entry")
                }
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .navigationTitle(page?.entry.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.marketGeneration) { await load() }
        .sheet(item: $reviewing) { ask in
            MarketReviewSheet(model: model, mode: ask.mode, machineName: machineName) { _ in
                Task { await load() }
            }
        }
        .confirmationDialog(page?.entry.removeQuestion ?? "", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { remove() }.accessibilityIdentifier("market.entry.remove.confirm")
        } message: {
            Text(page?.entry.removeLine ?? "")
        }
        .sensoryFeedback(.warning, trigger: removed)
        .accessibilityIdentifier("market.entry")
    }

    // MARK: Header

    private func header(_ detail: MarketEntryPage.Entry) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            HStack(alignment: .top, spacing: AceDesign.Space.row) {
                art
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(detail.title).aceFont(AceDesign.TextRole.header).foregroundStyle(AceDesign.Ink.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(detail.line).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    publisher(detail)
                }
            }
            .accessibilityElement(children: .combine)
            action(detail)
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }

    /// A bot's own face, else the listing's first picture, else the market's glyph.
    @ViewBuilder private var art: some View {
        let side = AceDesign.Size.spade
        if let face {
            SpadeFaceView(face: face, size: side)
        } else if let picture {
            Image(uiImage: picture).resizable().scaledToFill()
                .frame(width: side, height: side).clipShape(AceShape.group).accessibilityHidden(true)
        } else {
            AceIcon(.storefront, size: AceDesign.Size.emptyIcon, relativeTo: .title2).foregroundStyle(AceDesign.Ink.muted)
                .frame(width: side, height: side).accessibilityHidden(true)
        }
    }

    private func publisher(_ detail: MarketEntryPage.Entry) -> some View {
        HStack(spacing: AceDesign.Space.tight) {
            Text([detail.typeWord, detail.publisher].compactMap { $0 }.joined(separator: " · "))
            if let mark = detail.publisherMark {
                AceIcon(.sealCheck, size: AceDesign.Size.glyphMeta, relativeTo: .caption).accessibilityHidden(true)
                Text(mark)
            }
        }
        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
    }

    /// The one action, or why there is none; an install's state and its ways to change it.
    @ViewBuilder private func action(_ detail: MarketEntryPage.Entry) -> some View {
        if let block = detail.block, detail.installed == nil {
            Text(block).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("market.entry.block")
        }
        if let word = detail.actionWord {
            if detail.action == "installed" {
                Text(word).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("market.entry.installed")
            } else {
                Button { get(detail) } label: { Text(word).frame(maxWidth: .infinity) }
                    .buttonStyle(.primaryAction).controlSize(.large)
                    .disabled(!online || !model.canOperate || busy)
                    .accessibilityIdentifier("market.entry.action")
            }
        }
        if !online {
            Text("Your machine is offline, so nothing can be installed or removed.")
                .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
        }
        if let install = detail.installed {
            if let note = detail.installedNote {
                words("Installed on \(machineName). \(note)").accessibilityIdentifier("market.entry.suitNote")
            }
            if install.waitsForBots {
                MarketBotsApproval(model: model, install: install) { _ in Task { await load() } }
            } else if install.state != "on" || install.update != nil {
                Text(install.status).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            HStack(spacing: AceDesign.Space.group) {
                if let turnOn = detail.turnOnWord {
                    Button(turnOn) { turnBackOn(install) }.buttonStyle(.textAction(.prominent))
                        .disabled(!online || busy).accessibilityIdentifier("market.entry.turnOn")
                }
                Button("Remove") { removing = true }.buttonStyle(.textAction(.destructive))
                    .disabled(!online || busy || !model.canOperate).accessibilityIdentifier("market.entry.remove")
            }
        }
    }

    // MARK: Facts

    private func information(_ detail: MarketEntryPage.Entry) -> some View {
        QuietSection("Information") {
            fact("Review", detail.reviewMark)
            if let publisher = detail.publisher { fact("Publisher", publisher) }
            fact("Source", detail.sourceText)
            fact("Downloads", detail.downloadsText)
            if let install = detail.installed { fact("Installed", "Version \(install.version) on \(machineName)") }
        }
    }

    private func versions(_ detail: MarketEntryPage.Entry) -> some View {
        QuietSection("Versions") {
            ForEach(detail.versions, id: \.self) { version in
                QuietSectionRow {
                    QuietRowText(title: version.version,
                                 detail: [version.date, version.size, version.withdrawn.map { "Withdrawn: \($0)" }]
                                     .compactMap { $0 }.joined(separator: " · "))
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        QuietSectionRow {
            Text(label).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
            Spacer(minLength: AceDesign.Space.related)
            Text(value).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }

    private func words(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Reads and changes

    private func load() async {
        do {
            let fresh = try await model.marketEntry(entry)
            page = fresh
            problem = nil
            await readArt(fresh.entry)
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }

    /// What it may do and a bot's face come from its review: prepared once, then cancelled, so
    /// the machine holds nothing for a page that is only looked at. Get prepares its own.
    private func readArt(_ detail: MarketEntryPage.Entry) async {
        if picture == nil, let hash = detail.picture, let read = try? await model.marketPicture(hash, kind: "preview") {
            picture = await Task.detached(priority: .userInitiated) {
                Data(base64Encoded: read.data).flatMap(ImageDecoding.source).flatMap { ImageDecoding.preview($0, pixels: 240) }
            }.value
        }
        guard canDo.isEmpty, detail.action == "install" || detail.action == "update", model.canOperate,
              let review = try? await model.marketPrepare(entry) else { return }
        canDo = review.canDo
        face = review.bot?.face
        try? await model.marketCancel(review)
    }

    private func get(_ detail: MarketEntryPage.Entry) {
        changeProblem = nil
        if detail.action == "update", let install = detail.installed {
            reviewing = Ask(mode: .update(install.key))
        } else {
            reviewing = Ask(mode: .install(detail.key))
        }
    }

    private func remove() {
        guard let install = page?.entry.installed else { return }
        change { try await model.marketRemove(install.key); removed += 1 }
    }

    private func turnBackOn(_ install: MarketInstall) {
        change { _ = try await model.marketTurnOn(install.key) }
    }

    private func change(_ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        changeProblem = nil
        Task {
            defer { busy = false }
            do {
                try await work()
                await load()
            } catch let refusal as MarketRefusal {
                changeProblem = refusal.message
            } catch {}
        }
    }
}
