import SwiftUI

/// The places outside the thread lists, as the web's rail lists them: Pull requests, Issues,
/// Automations, Skills, Usage, Machines and Settings. Search shows them before a query; the iPad
/// sidebar's rail shows the same places as glyphs. Spade is a tab (`HomeTabs.showsSpade`), not
/// a place.
enum SearchPlace: String, CaseIterable, Identifiable {
    case pulls, issues, automations, skills, usage, machines, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pulls: "Pull requests"
        case .issues: "Issues"
        case .automations: "Automations"
        case .skills: "Skills"
        case .usage: "Usage"
        case .machines: "Machines"
        case .settings: "Settings"
        }
    }

    var icon: AceIcon.Name {
        switch self {
        case .pulls: .gitPullRequest
        case .issues: .target
        case .automations: SettingsTool.automations.icon
        case .skills: SettingsTool.skills.icon
        case .usage: SettingsTool.usage.icon
        case .machines: .desktop
        case .settings: .gearSix
        }
    }

    /// A machine tool's page needs a machine to read; the rest open without one.
    var tool: SettingsTool? {
        switch self {
        case .automations: .automations
        case .skills: .skills
        case .usage: .usage
        default: nil
        }
    }

    /// The places the app can open with the machines it has: a tool needs one paired.
    static func offered(paired: Bool) -> [SearchPlace] {
        allCases.filter { paired || ($0.tool == nil && $0 != .pulls && $0 != .issues) }
    }
}

/// The places as capsules that wrap to the next line: words only (design language §2.3), Pull
/// requests with how many are open in the project it opens on, in the subtle ink.
struct SearchPlaceCapsules: View {
    let places: [SearchPlace]
    /// Open pull requests in the project Pull requests opens on; nil until read.
    let openPulls: Int?
    let open: (SearchPlace) -> Void

    var body: some View {
        ChipFlow(spacing: AceDesign.Space.related) {
            ForEach(places) { place in
                Button { open(place) } label: { capsule(place) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(label(place))
                    .accessibilityIdentifier("search.place.\(place.rawValue)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func capsule(_ place: SearchPlace) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            Text(place.title).lineLimit(1)
            if place == .pulls, let openPulls, openPulls > 0 {
                Text(openPulls.formatted()).monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
        .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.foreground)
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(minHeight: AceDesign.Size.tap)
        .background(AceDesign.Surface.fill, in: AceShape.capsule)
        .contentShape(AceShape.capsule)
    }

    private func label(_ place: SearchPlace) -> String {
        switch place {
        case .pulls: openPulls.map { "Pull requests, \($0) open" } ?? place.title
        default: place.title
        }
    }
}
