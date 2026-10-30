#if os(iOS)
import SwiftUI
import UIKit
import TallylineCore

/// Silver Lining tokens, iOS edition. Every colour comes from the generated
/// `SilverLiningTokens` table (packages/silver-lining is the single source), and
/// resolves per trait: light, dark, or high-contrast dark.
public enum Theme {
    public static let canvas = token(\.canvas)
    public static let surface1 = token(\.surface1)
    public static let surface2 = token(\.surface2)
    public static let surface3 = token(\.surface3)
    public static let surface4 = token(\.surface4)

    public static let liningFaint = token(\.liningFaint)
    public static let lining = token(\.lining)
    public static let liningStrong = token(\.liningStrong)

    public static let ink = token(\.ink)
    public static let inkMuted = token(\.inkMuted)
    public static let inkSubtle = token(\.inkSubtle)
    public static let inkDisabled = token(\.inkDisabled)

    public static let accent = token(\.accent)
    public static let accentSoft = token(\.accentSoft)
    public static let onAccent = token(\.onAccent)

    public static let urgent = token(\.statusUrgent)
    public static let attention = token(\.statusAttention)
    public static let healthy = token(\.statusHealthy)
    public static let neutral = token(\.statusNeutral)

    /// Agent glint: the four-point star marking anything an agent touched.
    public static let glint = token(\.glint)
    public static let scrim = token(\.scrim)

    // DESIGN.md radius scale. 8 is the default; nothing above 14.
    public static let radiusXs: CGFloat = 4
    public static let radiusSm: CGFloat = 6
    public static let radiusMd: CGFloat = 8
    public static let radiusLg: CGFloat = 10
    public static let radiusXl: CGFloat = 14

    /// A colour that follows light, dark and Increase Contrast.
    public static func token(_ path: KeyPath<SilverLiningPalette, String>) -> Color {
        // Resolve all three up front so the trait closure captures only UIColors.
        let light = UIColor(silverLining: SilverLiningTokens.light[keyPath: path])
        let dark = UIColor(silverLining: SilverLiningTokens.dark[keyPath: path])
        let hcDark = UIColor(silverLining: SilverLiningTokens.hcDark[keyPath: path])
        return Color(UIColor { traits in
            guard traits.userInterfaceStyle == .dark else { return light }
            return traits.accessibilityContrast == .high ? hcDark : dark
        })
    }
}

extension UIColor {
    /// Builds a UIColor from a generated token string. Unparseable values are a
    /// generator bug; they render magenta so they cannot hide.
    convenience init(silverLining value: String) {
        let c = SilverLiningRGBA.parse(value) ?? SilverLiningRGBA(red: 1, green: 0, blue: 1)
        self.init(red: c.red, green: c.green, blue: c.blue, alpha: c.alpha)
    }
}

/// User-facing appearance override, stored in AppStorage as its raw value.
public extension SilverLiningAppearance {
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    var label: String {
        switch self {
        case .system: "Match system"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}
#endif
