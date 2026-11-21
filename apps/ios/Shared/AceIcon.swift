import SwiftUI

/// One of ace's own icons from `Icons.xcassets` (ADR 0156: the `@ace/icons` set the web draws;
/// regular weight, bold only at 12pt, filled only for the short list `generate-icons.ts` writes:
/// row status marks, a starred or picked choice). It takes `currentColor`: set the row's tier with `foregroundStyle`.
/// `size` is the point size at the default text size and grows with Dynamic Type beside
/// `relativeTo`. Decorative: the control or row it sits in carries the words.
///
/// The app draws no SF Symbols (`scripts/check-no-sf-symbols.ts`); the table in
/// `scripts/icon-names.ts` says which icon replaced each one: an image becomes `AceIcon(.folder)`,
/// a label `Label("Copy", ace: .copy)`, a button `Button("Archive", ace: .archive) { … }`.
struct AceIcon: View {
    enum Weight: Sendable { case regular, bold, fill }
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

extension AceIcon.Name {
    /// The icon's image in `Icons.xcassets`.
    /// A name with no filled drawing draws its outline when asked for `.fill`.
    func asset(_ weight: AceIcon.Weight = .regular) -> String {
        switch weight {
        case .regular: "icon-\(rawValue)"
        case .bold: "icon-\(rawValue)-bold"
        case .fill: Self.filled.contains(self) ? "icon-\(rawValue)-fill" : "icon-\(rawValue)"
        }
    }
}

extension Image {
    /// The icon at its 20pt intrinsic size, for places that take an `Image` and size it
    /// themselves: menus, swipe actions, `Label` icons.
    init(ace name: AceIcon.Name, weight: AceIcon.Weight = .regular) {
        self.init(name.asset(weight))
    }
}

extension UIImage {
    /// The icon for UIKit menus and buttons, at its 20pt intrinsic size.
    convenience init?(ace name: AceIcon.Name, weight: AceIcon.Weight = .regular) {
        self.init(named: name.asset(weight))
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
