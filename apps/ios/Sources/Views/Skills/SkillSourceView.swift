import SwiftUI

/// What a plugin ships, one component at a time: its description, which agents get it in new
/// sessions, and its source (read, or edited through a review). Cardless, as the design
/// language's inner pages.
struct SkillSourceView: View {
    let model: ClientModel
    let component: PluginComponentRow
    @State private var source = ""
    @State private var original = ""
    @State private var hash: String?
    @State private var problem: String?
    @State private var editing = false
    @State private var loading = false
    @State private var enabled: Bool?
    @State private var providers: [String]?
    @State private var review: PluginReviewRequest?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                QuietSection {
                    QuietSectionRow {
                        Text(component.description).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if component.kind == "skill", model.canOperate {
                        QuietSectionRow {
                            Toggle("Enabled for new sessions", isOn: Binding(get: { enabled ?? component.skillAvailability?.enabled ?? component.enabled }, set: { on in availability(enabled: on, providers: providers ?? component.skillAvailability?.providers ?? component.providers) }))
                        }
                        ForEach(ProviderLabels.ids, id: \.self) { provider in
                            QuietSectionRow {
                                Toggle(provider.capitalized, isOn: Binding(get: { (providers ?? component.skillAvailability?.providers ?? component.providers).contains(provider) }, set: { on in
                                    var selected = providers ?? component.skillAvailability?.providers ?? component.providers
                                    selected.removeAll { $0 == provider }; if on { selected.append(provider) }
                                    availability(enabled: enabled ?? component.skillAvailability?.enabled ?? component.enabled, providers: selected)
                                }))
                            }
                        }
                    }
                }
                if loading { SkeletonRows(count: 4, label: "Reading source") }
                if let problem {
                    QuietProblem(message: problem) { Task { await read() } }
                }
                if hash != nil {
                    if editing {
                        QuietSection {
                            QuietSectionRow {
                                TextEditor(text: $source).frame(minHeight: AceDesign.Size.editorHeight).scrollContentBackground(.hidden)
                                    .aceMonospace(AceTheme.Typography.code, relativeTo: .footnote)
                            }
                        }
                        Button("Review changes") {
                            if let hash { review = PluginReviewRequest(operation: ["type": "plugins.edit", "name": component.plugin, "path": component.path, "expectedHash": hash, "text": source]) }
                        }
                        .buttonStyle(.textAction(.prominent))
                        .disabled(source == original || source.utf16.count > 262144)
                        .padding(.horizontal, AceDesign.Space.margin)
                    } else {
                        QuietSection {
                            QuietSectionRow {
                                AceMarkdown(text: source)
                                    .padding(.vertical, AceDesign.Space.tight)
                            }
                        }
                        if model.canOperate {
                            Button("Edit source") { editing = true }
                                .buttonStyle(.textAction(.prominent))
                                .disabled(source.utf16.count > 262144)
                                .padding(.horizontal, AceDesign.Space.margin)
                        }
                    }
                }
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .navigationTitle(component.title ?? component.name).navigationBarTitleDisplayMode(.inline)
        .task { await read() }
        .sheet(item: $review) { PluginReviewView(model: model, request: $0, installed: { editing = false; Task { await read() } }) }
    }
    private func availability(enabled: Bool, providers: [String]) {
        Task {
            do {
                _ = try await model.plugin(["type": "plugins.skillAvailability", "plugin": component.plugin, "name": component.name, "enabled": enabled, "providers": providers], expecting: "plugins.skillAvailability")
                self.enabled = enabled; self.providers = providers; problem = nil
            } catch { problem = error.localizedDescription }
        }
    }
    private func read() async {
        loading = true; problem = nil
        defer { loading = false }
        do {
            var offset = 0
            var fingerprint: String?
            var parts: [String] = []
            for _ in 0..<66 {
                let page = try await model.plugin(["type": "plugins.source", "name": component.plugin, "path": component.path, "offset": offset], expecting: "plugins.source")
                guard let bytes = page.bytes, bytes <= 4 * 1024 * 1024, page.offset == offset,
                      let next = page.nextOffset, next <= bytes, let nextHash = page.hash, let text = page.text,
                      fingerprint == nil || fingerprint == nextHash else { throw ServiceFailure(message: "The source changed while reading. Refresh and try again.") }
                fingerprint = nextHash; parts.append(text)
                if next == bytes { original = parts.joined(); source = original; hash = nextHash; return }
                guard next > offset else { break }
                offset = next
            }
            throw ServiceFailure(message: "This source is too large to open on the phone.")
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
