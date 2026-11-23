import PhotosUI
import SwiftUI

/// The publisher profile (#2554), edited and saved: name, handle, picture, what they say about
/// themselves and up to five links. With no profile yet it makes one from a handle and a name.
/// Save sends only what changed: the name, bio and links together, then a new handle and a new
/// picture each on their own. Refused for standing, Confirm it's you sends Save once more.
struct MarketProfileEdit: View {
    let model: ClientModel
    /// The profile as it is; nil to make one.
    let profile: MarketPublisherProfile?
    let saved: (MarketPublisherProfile) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var handle = ""
    @State private var bio = ""
    @State private var links: [MarketPublisherProfile.Link] = []
    @State private var photo: PhotosPickerItem?
    @State private var picture: MarketPublishPicture?
    @State private var problem: MarketRefusal?
    @State private var working = false

    private static let linkLimit = 5
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedHandle: String { handle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    private var cleanLinks: [MarketPublisherProfile.Link] {
        links.map { .init(label: $0.label.trimmingCharacters(in: .whitespaces), url: $0.url.trimmingCharacters(in: .whitespaces)) }
            .filter { !$0.label.isEmpty || !$0.url.isEmpty }
    }
    private var linksValid: Bool {
        cleanLinks.allSatisfy { !$0.label.isEmpty && $0.url.hasPrefix("https://") && URL(string: $0.url)?.host() != nil }
    }
    private var ready: Bool {
        !working && !trimmedName.isEmpty && trimmedHandle.count >= 3 && linksValid && model.connection == "ready"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name).textContentType(.name)
                        .accessibilityIdentifier("market.profile.name")
                    TextField("Handle", text: $handle)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("market.profile.handle")
                }
                if profile != nil {
                    Section {
                        PhotosPicker(selection: $photo, matching: .images) {
                            InsetRow(picture == nil ? "Choose a picture" : "Picture chosen", icon: .image)
                        }
                        .accessibilityIdentifier("market.profile.picture")
                        TextField("About you", text: $bio, axis: .vertical).lineLimit(2...6)
                            .accessibilityIdentifier("market.profile.bio")
                    }
                    linksSection
                }
                if let problem {
                    Section {
                        if problem.asksForPerson {
                            MarketConfirmPerson(refusal: problem, hostId: model.hostId, busy: working, close: { dismiss() }) {
                                Task { await save(confirmed: true) }
                            }
                        } else {
                            ProblemRow(problem.message, detail: problem.reason, id: "market.profile.problem")
                        }
                    }
                }
            }
            .navigationTitle(profile == nil ? "New profile" : "Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(working)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(working ? "Saving…" : "Save") { Task { await save(confirmed: false) } }
                        .disabled(!ready)
                        .accessibilityIdentifier("market.profile.save")
                }
            }
        }
        .interactiveDismissDisabled(working)
        .onAppear(perform: fill)
        .onChange(of: photo) { _, item in Task { await choose(item) } }
    }

    private var linksSection: some View {
        Section {
            ForEach($links.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                    TextField("Label", text: $links[index].label)
                    TextField("https://", text: $links[index].url)
                        .textContentType(.URL).keyboardType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .swipeActions { Button("Remove", ace: .trash, role: .destructive) { links.remove(at: index) } }
            }
            if links.count < Self.linkLimit {
                Button { links.append(.init(label: "", url: "")) } label: { AddRow("Add link") }
                    .accessibilityIdentifier("market.profile.addLink")
            }
        } header: { InsetHeader("Links") } footer: {
            if !linksValid { Text("Each link needs a label and an https address.") }
        }
    }

    private func fill() {
        guard let profile else { return }
        name = profile.name
        handle = profile.handle
        bio = profile.bio
        links = profile.links
    }

    private func choose(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        picture = MarketPublishPicture.make(data)
    }

    private func save(confirmed: Bool) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            var result: MarketPublisherProfile
            if let profile {
                result = profile
                if trimmedName != profile.name || bio != profile.bio || cleanLinks != profile.links {
                    result = try await model.marketEditProfile(name: trimmedName, bio: bio, links: cleanLinks, confirmed: confirmed)
                }
                if trimmedHandle != profile.handle {
                    result = try await model.marketChangeHandle(trimmedHandle, confirmed: confirmed)
                }
                if let picture {
                    result = try await model.marketSetAvatar(picture.base64, confirmed: confirmed)
                    self.picture = nil
                }
            } else {
                result = try await model.marketCreateProfile(handle: trimmedHandle, name: trimmedName, bio: bio)
            }
            saved(result)
            dismiss()
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}
