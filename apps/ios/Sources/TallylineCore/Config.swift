import Foundation

/// Build-time constants for the app. The release pipeline may substitute a
/// different file — keep it values-only, no secrets.
public enum TallylineConfig {
    /// Default instance the sign-in screen offers. Self-hosters type their own.
    public static let defaultServerURL = URL(string: "https://api.tallyline.app")!

    /// Custom URL scheme the app answers (tallyline://pair?s=…&c=…).
    public static let urlScheme = "tallyline"
}
