#if os(iOS)
import SwiftUI

/// The motion grammar, defined once. Views name a token; they never write a
/// raw duration or curve. Reduce Motion (the system setting, or the app's own
/// override) turns every token into a short fade and stops ambient motion.
public enum MotionToken: Sendable {
    /// Pill selection, toggles, badge counts.
    case quick
    /// List inserts and removals, state glyph changes, sheet detents.
    case standard
    /// Zoom navigation, ring fill on first appear.
    case hero
    /// The agent glint's slow pulse. Never runs under Reduce Motion.
    case ambient
}

public enum Motion {
    public static let quick: Animation = .spring(duration: 0.18, bounce: 0)
    public static let standard: Animation = .spring(duration: 0.28, bounce: 0)
    public static let hero: Animation = .spring(duration: 0.42, bounce: 0.14)
    public static let ambient: Animation = .spring(duration: 1.6, bounce: 0).repeatForever(autoreverses: true)
    public static let reduced: Animation = .linear(duration: 0.12)

    /// The animation for a token, or nil when it must not animate at all.
    public static func animation(_ token: MotionToken, reduceMotion: Bool) -> Animation? {
        switch token {
        case .ambient: reduceMotion ? nil : ambient
        case .quick: reduceMotion ? reduced : quick
        case .standard: reduceMotion ? reduced : standard
        case .hero: reduceMotion ? reduced : hero
        }
    }
}

private struct AppReducesMotionKey: EnvironmentKey {
    static let defaultValue = false
}

public extension EnvironmentValues {
    /// The app's own "Reduce app motion" switch (Settings > Appearance). It
    /// adds to the system setting; it never overrides it off.
    var appReducesMotion: Bool {
        get { self[AppReducesMotionKey.self] }
        set { self[AppReducesMotionKey.self] = newValue }
    }
}

private struct MotionModifier<Value: Equatable>: ViewModifier {
    let token: MotionToken
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var systemReduces
    @Environment(\.appReducesMotion) private var appReduces

    func body(content: Content) -> some View {
        content.animation(Motion.animation(token, reduceMotion: systemReduces || appReduces), value: value)
    }
}

public extension View {
    /// Animates changes of `value` with a motion token.
    func motion<Value: Equatable>(_ token: MotionToken, value: Value) -> some View {
        modifier(MotionModifier(token: token, value: value))
    }
}

/// How dense rows and pills are. Chosen in Settings > Appearance.
public enum Density: String, CaseIterable, Sendable {
    case comfortable, compact

    public var label: String {
        switch self {
        case .comfortable: "Comfortable"
        case .compact: "Compact"
        }
    }

    var rowSpacing: CGFloat { self == .comfortable ? 4 : 2 }
    var verticalPadding: CGFloat { self == .comfortable ? 4 : 0 }
    var titleLines: Int { self == .comfortable ? 2 : 1 }
}

private struct DensityKey: EnvironmentKey {
    static let defaultValue = Density.comfortable
}

public extension EnvironmentValues {
    var density: Density {
        get { self[DensityKey.self] }
        set { self[DensityKey.self] = newValue }
    }
}
#endif
