# Records the README demo. Run through demo-env.sh so every value is fake.
Output demo.gif
Set Shell "bash"
Set FontFamily "Geist Mono"
Set FontSize 16
Set Width 1000
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "source ./demo-env.sh && clear" Enter
Sleep 1.5s
Show

Type "tallyline" Enter
Sleep 2s
Type "tallyline connect" Enter
Sleep 1s
Type "http://127.0.0.1:4010" Sleep 400ms Enter
Sleep 800ms
Type "tly_pat_demo" Sleep 400ms Enter
Sleep 2.5s
Type "clear" Enter
Type "tallyline" Enter
Sleep 3s
Type "tallyline doctor" Enter
Sleep 3.5s
Type "tallyline show ACME-999" Enter
Sleep 3s
