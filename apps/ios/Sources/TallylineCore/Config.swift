import Foundation

/// Build-time constants for the app. The release pipeline may substitute a
/// different file — keep it values-only, no secrets.
public enum TallylineConfig {
    /// Default instance the sign-in screen offers. Self-hosters type their own.
    public static let defaultServerURL = URL(string: "https://api.tallyline.app")!

    /// Web origins whose `/issues/<KEY>` links open in the app. The owner's
    /// associated-domains entitlement decides whether iOS ever hands one to
    /// the app; until it ships these are never delivered.
    public static let webHosts: Set<String> = ["tallyline.app", "www.tallyline.app"]

    /// Custom URL scheme the app answers (tallyline://pair?s=…&c=…).
    public static let urlScheme = "tallyline"
}
