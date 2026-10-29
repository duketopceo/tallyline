import XCTest

/// Shared UI-test scaffolding. Real flows land with the screens that own them.
class TallylineUITestCase: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }
}
