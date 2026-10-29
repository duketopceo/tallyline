#if os(iOS)
import SwiftUI
import UIKit

/// Silver Lining tokens, iOS edition. Values mirror the web design contract
/// (DESIGN.md): azure accent, layered surfaces, muted ink, compact radii.
public enum Theme {
    public static let accent = Color.dynamic(light: Color(red: 0.043, green: 0.400, blue: 0.800), dark: Color(red: 0.243, green: 0.631, blue: 0.969))

    public static let canvas = Color.dynamic(light: .white, dark: Color(red: 0.043, green: 0.043, blue: 0.051))
    public static let surface1 = Color.dynamic(light: Color(white: 0.97), dark: Color(white: 0.10))
    public static let surface2 = Color.dynamic(light: Color(white: 0.94), dark: Color(white: 0.14))
    public static let lining = Color.dynamic(light: Color(white: 0.88), dark: Color(white: 0.20))

    public static let ink = Color.dynamic(light: Color(white: 0.10), dark: Color(white: 0.93))
    public static let inkMuted = Color.dynamic(light: Color(white: 0.35), dark: Color(white: 0.60))
    public static let inkSubtle = Color.dynamic(light: Color(white: 0.55), dark: Color(white: 0.42))

    public static let radiusSm: CGFloat = 6
    public static let radiusMd: CGFloat = 10

    /// Agent glint — the four-point star marking anything an agent touched.
    public static let glint = accent
}

extension Color {
    /// Light/dark variant pair without an asset catalog entry.
    static func dynamic(light: Color, dark: Color) -> Color {
        Color(UIColor { traits in traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }
}
#endif
