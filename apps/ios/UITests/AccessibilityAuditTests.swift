import XCTest

/// Xcode's accessibility audit on the first screen a new user sees (S6-U6).
/// Signed-in screens need a paired server, which CI does not have; their
/// labels are covered by IssueSpeech tests in TallylineCore.
final class AccessibilityAuditTests: TallylineUITestCase {
    func testSignInScreenPassesTheAudit() throws {
        try app.performAccessibilityAudit(for: [.dynamicType, .sufficientElementDescription, .hitRegion, .textClipped])
    }

    func testSignInScreenAtTheLargestTextSize() throws {
        app.terminate()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        try app.performAccessibilityAudit(for: [.sufficientElementDescription, .textClipped])
    }
}
