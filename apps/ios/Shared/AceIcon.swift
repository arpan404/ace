import SwiftUI

/// A Phosphor icon from `Icons.xcassets` (DESIGN.md "Icons": Phosphor only, regular weight;
/// bold only at 12pt). It takes `currentColor`: set the row's tier with `foregroundStyle`.
/// `size` is the point size at the default text size and grows with Dynamic Type beside
/// `relativeTo`. Decorative: the control or row it sits in carries the words.
///
/// Swapping an SF Symbol is mechanical with the table in `scripts/generate-icons.ts`:
/// `Image(systemName: "folder")` → `AceIcon(.folder)`,
/// `Label("Copy", systemImage: "doc.on.doc")` → `Label("Copy", ace: .copy)`,
/// `Button("Archive", systemImage: "archivebox") { … }` → `Button("Archive", ace: .archive) { … }`.
struct AceIcon: View {
    enum Weight: Sendable { case regular, bold }
    let name: Name
    let weight: Weight
    @ScaledMetric private var size: CGFloat

    init(_ name: Name, size: CGFloat = 20, weight: Weight = .regular, relativeTo: Font.TextStyle = .body) {
        self.name = name
        self.weight = weight
        _size = ScaledMetric(wrappedValue: size, relativeTo: relativeTo)
    }

    var body: some View {
        Image(ace: name, weight: weight)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

extension Image {
    /// The icon at its 20pt intrinsic size, for places that take an `Image` and size it
    /// themselves: menus, swipe actions, `Label` icons.
    init(ace name: AceIcon.Name, weight: AceIcon.Weight = .regular) {
        self.init(weight == .bold ? "ph-\(name.rawValue)-bold" : "ph-\(name.rawValue)")
    }
}

extension Label where Title == Text, Icon == Image {
    init(_ titleKey: LocalizedStringKey, ace name: AceIcon.Name) {
        self.init { Text(titleKey) } icon: { Image(ace: name) }
    }
    init<S: StringProtocol>(_ title: S, ace name: AceIcon.Name) {
        self.init { Text(title) } icon: { Image(ace: name) }
    }
}

extension Button where Label == SwiftUI.Label<Text, Image> {
    init(_ titleKey: LocalizedStringKey, ace name: AceIcon.Name, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(titleKey, ace: name) }
    }
    init<S: StringProtocol>(_ title: S, ace name: AceIcon.Name, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(title, ace: name) }
    }
}
