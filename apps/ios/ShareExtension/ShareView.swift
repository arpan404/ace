import SwiftUI

/// Cancel · New thread · Send; the project as a pill; the shared words in a field to edit; the
/// shared images under it. After Send it closes into ace, or says the start waits for ace.
struct ShareView: View {
    @Bindable var model: ShareModel
    let cancel: () -> Void
    let sent: (URL) -> Void
    @FocusState private var writing: Bool

    var body: some View {
        NavigationStack {
            Group {
                if model.waiting { waiting } else { form }
            }
            .background(AceTheme.Colours.background)
            .navigationTitle(model.project?.projectId == HandoffCatalogue.chat ? "New chat" : "New thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.waiting {
                    ToolbarItem(placement: .confirmationAction) { Button("Done", action: cancel) }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send") { if let url = model.send(now: Date()) { sent(url) } }
                            .fontWeight(.semibold)
                            .disabled(!model.canSend)
                    }
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .onAppear { writing = true }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: ShareLayout.related) {
            if !model.catalogue.projects.isEmpty { projectPill }
            TextField(model.reading ? "" : "Describe a task", text: $model.text, axis: .vertical)
                .font(.body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(3...12)
                .focused($writing)
                .accessibilityIdentifier("share.message")
            if !model.images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: ShareLayout.related) {
                        ForEach(model.images.indices, id: \.self) { index in
                            if let image = UIImage(data: model.images[index].data) {
                                Image(uiImage: image).resizable().scaledToFill()
                                    .frame(width: ShareLayout.thumbnail, height: ShareLayout.thumbnail)
                                    .clipShape(Circle())
                                    .accessibilityLabel(model.images[index].name)
                            }
                        }
                    }
                }
            }
            if let problem = model.problem {
                Text(problem).font(.footnote).foregroundStyle(AceTheme.StatusText.failed)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, ShareLayout.margin)
        .padding(.top, ShareLayout.related)
    }

    /// The project it starts in, by machine when there's more than one.
    private var projectPill: some View {
        Menu {
            ForEach(model.catalogue.machines.filter(\.canOperate)) { machine in
                let projects = model.catalogue.projects.filter { $0.machineId == machine.id }
                Section(model.catalogue.machines.count > 1 ? machine.name : "") {
                    ForEach(projects) { project in
                        Button { model.project = project } label: {
                            if project.id == model.project?.id { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: ShareLayout.tight) {
                Text(model.project?.name ?? "Project").lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            .font(.subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, ShareLayout.row)
            .frame(minHeight: ShareLayout.pill)
            .background(AceTheme.Colours.fill, in: Capsule())
            .padding(.vertical, (ShareLayout.tap - ShareLayout.pill) / 2)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Project").accessibilityValue(model.project?.name ?? "")
        .accessibilityIdentifier("share.project")
    }

    private var waiting: some View {
        VStack(alignment: .leading, spacing: ShareLayout.related) {
            Text("Saved on this phone").font(.headline).foregroundStyle(AceTheme.Colours.foreground)
            Text("It starts when you next open ace.").font(.subheadline).foregroundStyle(AceTheme.Colours.mutedForeground)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(ShareLayout.margin)
    }
}

/// The share sheet's measures: the app's token values (`AceDesign`), which the extension doesn't
/// link.
enum ShareLayout {
    static let tight: CGFloat = 4
    static let related: CGFloat = 8
    static let row: CGFloat = 12
    static let margin: CGFloat = 16
    static let tap: CGFloat = 44
    static let pill: CGFloat = 36
    static let thumbnail: CGFloat = 56
}
