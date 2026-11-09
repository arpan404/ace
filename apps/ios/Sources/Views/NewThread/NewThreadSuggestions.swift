import SwiftUI

/// The row above + and Send: the screenshot just taken, the skills last used in this project and
/// "Same as last time" when the picks have moved off the project's last ones. Each one shows only
/// while it would do something; with none, the row isn't there.
struct NewThreadSuggestions: View {
    let screenshot: LatestScreenshot?
    let skills: [NewThreadSkill]
    /// The project has `/` skills to pick from, but none used here yet.
    let offersSkills: Bool
    let sameAsLast: Bool
    let attachScreenshot: (LatestScreenshot) -> Void
    let pickSkill: (NewThreadSkill) -> Void
    let openSkills: () -> Void
    let restoreLast: () -> Void
    @State private var thumbnail: UIImage?
    @Environment(\.displayScale) private var scale

    static func shows(screenshot: LatestScreenshot?, skills: [NewThreadSkill], offersSkills: Bool, sameAsLast: Bool) -> Bool {
        screenshot != nil || !skills.isEmpty || offersSkills || sameAsLast
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceDesign.Space.related) {
                if let screenshot {
                    Button { attachScreenshot(screenshot) } label: {
                        capsule {
                            HStack(spacing: AceDesign.Space.tight) {
                                if let thumbnail {
                                    Image(uiImage: thumbnail).resizable().scaledToFill()
                                        .frame(width: AceDesign.Size.barIcon, height: AceDesign.Size.barIcon)
                                        .clipShape(Circle())
                                        .accessibilityHidden(true)
                                }
                                Text(screenshot.label)
                            }
                        }
                    }
                    .accessibilityLabel("Attach \(screenshot.label)")
                    .accessibilityIdentifier("newThread.screenshot")
                    .task(id: screenshot) { thumbnail = await screenshot.thumbnail(side: AceDesign.Size.barIcon, scale: scale) }
                }
                ForEach(skills) { skill in
                    Button { pickSkill(skill) } label: { capsule { Text(verbatim: "/" + skill.label) } }
                        .accessibilityLabel("Use \(skill.label)")
                        .accessibilityIdentifier("newThread.skill.\(skill.label)")
                }
                if skills.isEmpty, offersSkills {
                    Button(action: openSkills) { capsule { Text("Skills") } }
                        .accessibilityHint("Lists this project's skills")
                        .accessibilityIdentifier("newThread.skills")
                }
                if sameAsLast {
                    Button(action: restoreLast) { capsule { Text("Same as last time") } }
                        .accessibilityHint("Picks the model, access and place this project's last thread used")
                        .accessibilityIdentifier("newThread.sameAsLast")
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, AceDesign.Space.margin)
        }
        .scrollClipDisabled()
    }

    private func capsule<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .lineLimit(1)
            .aceFont(NewThreadStyle.chip, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceDesign.Space.row)
            .frame(minHeight: ComposerControlRow.height)
            .background(AceTheme.Colours.fill, in: AceShape.capsule)
            .padding(.vertical, (AceDesign.Size.tap - ComposerControlRow.height) / 2)
            .contentShape(Rectangle())
    }
}
