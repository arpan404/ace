import SwiftUI

/// The places outside the thread lists, as the web's rail lists them: Pull requests, Issues,
/// Automations, Skills, Usage, History, Archived, Machines and Settings. Search shows them before a query; the iPad
/// sidebar's rail shows the same places as glyphs. Spade isn't one of them: it is a
/// tab while a machine shows it (`HomeTabs`).
enum SearchPlace: String, CaseIterable, Identifiable {
    case pulls, issues, automations, skills, usage, history, archived, machines, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pulls: "Pull requests"
        case .issues: "Issues"
        case .automations: "Automations"
        case .skills: "Skills"
        case .usage: "Usage"
        case .history: "History"
        case .archived: "Archived"
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
        case .history: .clockCounterClockwise
        case .archived: .archive
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

    /// Machines and Settings open with no machine paired; the rest read one.
    var needsMachine: Bool { self != .machines && self != .settings }

    /// The places the app can open with the machines it has.
    static func offered(paired: Bool) -> [SearchPlace] {
        allCases.filter { paired || !$0.needsMachine }
    }
}

/// The places as a grid of tiles, each ace's own glyph (the iPad sidebar's) over its name, and
/// Pull requests with how many are open in the project it opens on, in the subtle ink. Three
/// across, two at the accessibility text sizes so every name stays whole.
struct SearchPlaceGrid: View {
    let places: [SearchPlace]
    /// Open pull requests in the project Pull requests opens on; nil until read.
    let openPulls: Int?
    let open: (SearchPlace) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: AceDesign.Space.related, alignment: .top),
              count: typeSize.isAccessibilitySize ? 2 : 3)
    }

    var body: some View {
        LazyVGrid(columns: columns, spacing: AceDesign.Space.related) {
            ForEach(places) { place in
                Button { open(place) } label: { tile(place) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(label(place))
                    .accessibilityIdentifier("search.place.\(place.rawValue)")
            }
        }
    }

    private func tile(_ place: SearchPlace) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            HStack(alignment: .center) {
                AceIcon(place.icon, size: AceDesign.Size.barIcon, relativeTo: .body)
                    .foregroundStyle(AceDesign.Ink.primary)
                Spacer(minLength: AceDesign.Space.tight)
                if let count = count(place) {
                    Text(count.formatted()).monospacedDigit()
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.subtle)
                }
            }
            Text(place.title)
                .aceFont(AceDesign.TextRole.action)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(AceDesign.Space.row)
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.rowThread, alignment: .topLeading)
        .background(AceDesign.Surface.fill, in: AceShape.group)
        .contentShape(AceShape.group)
    }

    /// Only Pull requests carries a count, and only once there is one to show.
    private func count(_ place: SearchPlace) -> Int? {
        guard place == .pulls, let openPulls, openPulls > 0 else { return nil }
        return openPulls
    }

    private func label(_ place: SearchPlace) -> String {
        switch place {
        case .pulls: openPulls.map { "Pull requests, \($0) open" } ?? place.title
        default: place.title
        }
    }
}
