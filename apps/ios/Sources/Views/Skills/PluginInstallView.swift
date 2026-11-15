import SwiftUI

/// Installing a plugin from a repository: where the code comes from and the branch or tag to
/// take, then Find plugins reads the repository's marketplace and lists what it offers to pick
/// from. A marketplace that can't be read takes the plugin's name typed instead. Then its review.
/// Fields sit on the page itself, as the design language's sheets draw them.
struct PluginInstallView: View {
    let model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @State private var repository = ""
    @State private var ref = ""
    /// What Find plugins read; a new repository or ref is a new listing.
    @State private var found: PluginMarketplace?
    @State private var name = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var work: Task<Void, Never>?
    @State private var review: PluginReviewRequest?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    QuietField("Git repository") {
                        TextField("owner/name or a git URL", text: $repository)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .disabled(busy)
                            .accessibilityIdentifier("plugins.install.repository")
                    }
                    QuietField("Branch or tag") {
                        TextField("Default branch", text: $ref)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .disabled(busy)
                            .accessibilityIdentifier("plugins.install.ref")
                    }
                    if let found { listing(found) }
                    if let problem { QuietProblem(message: problem, id: "plugins.install.problem") }
                    Button(busy ? "Fetching…" : found == nil ? "Find plugins" : "Review installation") { act() }
                        .buttonStyle(.textAction(.prominent))
                        .disabled(busy || repository.trimmingCharacters(in: .whitespaces).isEmpty || (found != nil && name.isEmpty) || !model.canOperate)
                        .padding(.horizontal, AceDesign.Space.margin)
                        .accessibilityIdentifier("plugins.install.next")
                    Text("ace reads the repository's marketplace, and shows you what a plugin runs before anything is installed.")
                        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, AceDesign.Space.margin)
                }
                .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
                .animation(.default, value: found)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("Install plugin").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onChange(of: repository) { found = nil; problem = nil }
            .onChange(of: ref) { found = nil; problem = nil }
            .onDisappear { work?.cancel() }
            .sheet(item: $review) { PluginReviewView(model: model, request: $0, installed: { dismiss() }) }
        }
    }

    /// The marketplace's plugins to pick one from, or the name typed when it couldn't be read.
    @ViewBuilder private func listing(_ found: PluginMarketplace) -> some View {
        if !found.plugins.isEmpty {
            QuietSection("Plugins in \(found.from)") {
                ForEach(found.plugins) { plugin in
                    Button { name = plugin.name } label: {
                        QuietSectionRow {
                            QuietRowText(title: [plugin.name, plugin.version].compactMap { $0 }.joined(separator: " "),
                                         detail: plugin.description, mono: true)
                            if name == plugin.name {
                                AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline)
                                    .foregroundStyle(AceDesign.Ink.primary)
                            }
                        }
                    }
                    .buttonStyle(.row)
                    .disabled(busy)
                    .accessibilityAddTraits(name == plugin.name ? .isSelected : [])
                    .accessibilityIdentifier("plugins.install.pick.\(plugin.name)")
                }
            }
        }
        if let note = found.note { QuietProblem(message: note, id: "plugins.install.note") }
        if found.manual {
            QuietField("Plugin name") {
                TextField("Plugin name", text: $name)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(busy)
                    .accessibilityIdentifier("plugins.install.name")
            }
        }
    }

    private func act() {
        guard !busy else { return }
        busy = true; problem = nil
        let listed = found
        work = Task {
            defer { busy = false }
            do {
                if let listed {
                    let checked = try await model.pluginAgents(["op": "source", "repository": listed.repository, "ref": listed.ref, "name": name],
                                                               as: PluginSourceChecked.self)
                    review = PluginReviewRequest(operation: checked.operation)
                } else {
                    let read = try await model.pluginAgents(["op": "find", "repository": repository, "ref": ref], as: PluginMarketplace.self)
                    guard !Task.isCancelled else { return }
                    found = read
                    name = read.picked ?? ""
                }
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
        }
    }
}
