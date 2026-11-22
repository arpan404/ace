import PhotosUI
import SwiftUI
import UIKit

/// A listing picture picked from Photos, made small enough for the market (at most 1 MiB).
struct MarketPublishPicture: Identifiable, Equatable {
    let id = UUID()
    let jpeg: Data
    var base64: String { jpeg.base64EncodedString() }

    /// The longest side the market shows a listing picture at.
    static let longestSide: CGFloat = 1600
    static let maxBytes = 1_000_000

    /// `data` as a JPEG under the market's limit, or nil when it isn't a picture.
    static func make(_ data: Data) -> MarketPublishPicture? {
        guard let image = UIImage(data: data) else { return nil }
        let scale = min(1, longestSide / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        for quality in [0.85, 0.7, 0.55, 0.4] {
            if let jpeg = drawn.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                return MarketPublishPicture(jpeg: jpeg)
            }
        }
        return nil
    }
}

/// The Describe step: the listing the Store shows (title, line, description, category,
/// pictures) and this version's notes, then Submit. Submit proves the person's standing on the
/// machine; refused for it, Confirm it's you sends it once more, and any other refusal shows its
/// sentence here.
struct MarketPublishDescribe: View {
    let model: ClientModel
    let hostId: String?
    @Bindable var flow: MarketPublishFlow
    let close: () -> Void
    @State private var photos: [PhotosPickerItem] = []
    @State private var problem: MarketRefusal?
    @State private var categories: [MarketHome.Category] = []

    private static let pictureLimit = 4
    private var ready: Bool {
        !flow.listing.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && flow.draft != nil && !flow.working
    }

    var body: some View {
        Form {
            Section {
                TextField("Title", text: $flow.listing.title)
                    .accessibilityIdentifier("market.publish.title")
                TextField("One line", text: $flow.listing.line, axis: .vertical)
                    .lineLimit(1...3)
                    .accessibilityIdentifier("market.publish.line")
                TextField("Description", text: $flow.listing.description, axis: .vertical)
                    .lineLimit(3...10)
                    .accessibilityIdentifier("market.publish.description")
            }
            if !categories.isEmpty {
                Section {
                    Picker("Category", selection: category) {
                        Text("None").tag(String?.none)
                        ForEach(categories) { Text($0.title).tag(Optional($0.id)) }
                    }
                    .accessibilityIdentifier("market.publish.category")
                }
            }
            picturesSection
            Section {
                TextField("What's new in this version", text: $flow.notes, axis: .vertical)
                    .lineLimit(2...6)
                    .accessibilityIdentifier("market.publish.notes")
            } header: { InsetHeader(flow.draft.map { "Version \($0.version)" } ?? "Version") }
            if let problem {
                Section {
                    if problem.asksForPerson {
                        MarketConfirmPerson(refusal: problem, hostId: hostId, busy: flow.working, close: close) {
                            Task { await submit(confirmed: true) }
                        }
                    } else {
                        ProblemRow(problem.message, detail: problem.reason, id: "market.publish.problem")
                    }
                }
            }
        }
        .navigationTitle("Listing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(flow.working ? "Submitting…" : "Submit") { Task { await submit(confirmed: false) } }
                    .disabled(!ready)
                    .accessibilityIdentifier("market.publish.submit")
            }
        }
        .task { categories = model.keptMarketHome?.categories ?? ((try? await model.marketHome())?.categories ?? []) }
        .onChange(of: photos) { _, picked in Task { await add(picked) } }
    }

    private var category: Binding<String?> {
        Binding(get: { flow.listing.categories.first },
                set: { flow.listing.categories = $0.map { [$0] } ?? [] })
    }

    private var picturesSection: some View {
        Section {
            if !flow.pictures.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceDesign.Space.related) {
                        ForEach(flow.pictures) { picture in
                            if let image = UIImage(data: picture.jpeg) {
                                Image(uiImage: image).resizable().scaledToFill()
                                    .frame(width: AceDesign.Size.spade, height: AceDesign.Size.spade)
                                    .clipShape(RoundedRectangle(cornerRadius: AceDesign.Radius.card, style: .continuous))
                                    .contextMenu {
                                        Button("Remove", ace: .trash, role: .destructive) {
                                            flow.pictures.removeAll { $0.id == picture.id }
                                        }
                                    }
                                    .accessibilityLabel("Picture")
                                    .accessibilityAction(named: "Remove") { flow.pictures.removeAll { $0.id == picture.id } }
                            }
                        }
                    }
                }
            }
            if flow.pictures.count < Self.pictureLimit {
                PhotosPicker(selection: $photos, maxSelectionCount: Self.pictureLimit - flow.pictures.count, matching: .images) {
                    AddRow(flow.pictures.isEmpty ? "Add pictures" : "Add more pictures")
                }
                .accessibilityIdentifier("market.publish.pictures")
            }
        } header: { InsetHeader("Pictures") }
    }

    private func add(_ picked: [PhotosPickerItem]) async {
        guard !picked.isEmpty else { return }
        photos = []
        for item in picked {
            guard flow.pictures.count < Self.pictureLimit,
                  let data = try? await item.loadTransferable(type: Data.self),
                  let picture = MarketPublishPicture.make(data) else { continue }
            flow.pictures.append(picture)
        }
    }

    private func submit(confirmed: Bool) async {
        guard let draft = flow.draft, !flow.working else { return }
        flow.working = true
        defer { flow.working = false }
        do {
            flow.published = try await model.marketSubmit(
                draft: draft.id, version: draft.version, notes: flow.notes, listing: flow.listing,
                pictures: flow.pictures.map(\.base64), confirmed: confirmed)
            problem = nil
            flow.path.append(.done)
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}
