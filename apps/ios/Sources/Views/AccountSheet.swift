import SwiftUI

/// The Account root uses the same navigation stack as Profile, Archive and Settings.
struct AccountSheet: View {
    @Environment(AceAccountModel.self) private var model: AceAccountModel?
    @Environment(SpacesModel.self) private var spaces: SpacesModel?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        List {
            Section {
                profile
            }
            .insetRowBackground()
            if let spaces, let listed = spaces.spaces, !listed.isEmpty {
                Section {
                    Picker("Space", selection: Binding(
                        get: { spaces.shown?.id ?? spaces.chosen },
                        set: { spaces.choose($0) }
                    )) {
                        Text("Personal").tag(Spaces.personal)
                        ForEach(listed) { org in Text(org.name).tag(org.id) }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("account.menu.spaces")
                }
                .insetRowBackground()
            }
            Section {
                GroupLink(.archive) { InsetRow("Archived threads", icon: .archive) }
                    .accessibilityIdentifier("account.menu.archived")
                GroupLink(.settings) { InsetRow("Settings", icon: .gearSix) }
                    .accessibilityIdentifier("account.menu.settings")
            }
            .insetRowBackground()
        }
        .environment(\.defaultMinListRowHeight, AceDesign.Size.tap)
        .insetGroupedList()
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var profile: some View {
        let person = model?.account
        let name = person?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = person == nil ? "Sign in to ace" : (name.isEmpty ? "You" : name)
        let label = [title, person?.email, "Profile"].compactMap { $0 }.filter { !$0.isEmpty }
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.related))
            : AnyLayout(HStackLayout(spacing: AceDesign.Space.row))

        return GroupLink(.account) {
            layout {
                AccountAvatar(name: name, picture: model?.picture, size: AceDesign.Size.accountPortrait)
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(title).font(.headline).foregroundStyle(AceDesign.Ink.primary)
                    if let email = person?.email, !email.isEmpty {
                        Text(email).font(.subheadline).foregroundStyle(AceDesign.Ink.muted)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                            .truncationMode(.middle)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, AceDesign.Space.related)
        }
        .accessibilityLabel(Text(label.joined(separator: ", ")))
        .accessibilityIdentifier("account.menu.profile")
    }
}
