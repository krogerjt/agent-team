/**
 * Hollis's runbook, distilled from taking a real app through App Store Connect on this framework.
 * Delivered on demand by the ios_playbook tool so the other agents (and Hollis's own prompt) stay small.
 * Facts here were learned the hard way; when one looks stale, verify it with web_search against Apple's documentation.
 */

export interface PlaybookTopic { id: string; title: string; text: string }

const overview = `END-TO-END FLOW (what Hollis does, what only the user can do)
Hollis, in order: ios_discover_project -> ios_check_readiness -> ios_prepare_release -> ios_run_operation generate-project / build-simulator / test-simulator -> ios_release_audit -> (UI screenshot run, see 'screenshots') -> ios_release_preflight -> archive -> export -> upload with validateOnly=true -> upload. Use ios_release_status after every step and say exactly what is verified, pending or blocked.
Success means status=success AND verified=true. A readiness check, an exit code, or a log line you read is not proof.
ONLY THE USER can: grant/revoke signing or upload permission (npm run ios -- grant signing|upload); enter or move credentials (certificates, API key, passwords); map secret NAMES and the Team ID (npm run ios -- settings); fill in forms in App Store Connect (listing, screenshots upload, App Privacy, age rating, pricing, review contact, build selection); click Add for Review; decide legal answers (export compliance, privacy policy wording, IP notices); merge and push to the default branch; enable GitHub Pages.
NEVER: ask for or repeat a secret value, invent legal text/URLs/pricing/copyright/Apple account details, put a phone number or home address in a public repository, submit for review, or call something done that a tool did not verify.
SELF-DIAGNOSIS before asking the user: ios_recent_runs (recent results and the redacted tail of any run's output log), ios_mac_maintenance (diagnose the Mac; clear stale jobs or the build cache; stop stray builds; only this tool's own folder and processes), the troubleshooting topic, then web_search/web_fetch with only the error text. Report what you tried and what the evidence showed.
Work for edits happens in a release workspace (ios_open_release_workspace): a separate Git worktree. Commit there with ios_commit_release_changes (local only). The user reviews and merges.
Topics: overview, mac-setup, credentials, signing-and-export, app-fixes, screenshots, app-store-connect, compliance-and-legal, publishing-pages, troubleshooting, next-release.`;

const macSetup = `MAC SETUP (the user runs these on the Mac; none involves secrets)
- Apple has required Xcode 26+ with the iOS 26 SDK for App Store uploads since 2026-04-28. Check with: xcodebuild -version.
- Intel Macs: Xcode 26.x has a 'Universal' build (runs on Intel, macOS 15.6+ for early 26.x releases; newer releases need newer macOS and may be Apple-silicon only). Download from developer.apple.com/download/all and read the requirements shown there. The App Store version may be Apple-silicon only. Verify current requirements with web_search.
- After installing: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer ; sudo xcodebuild -license accept ; sudo xcodebuild -runFirstLaunch ; xcrun simctl list runtimes available | grep iOS (download a runtime with: xcodebuild -downloadPlatform iOS). Move a downloaded Xcode.app into /Applications and delete the old one; confirm xcode-select -p points at the new one.
- Tools: XcodeGen (brew install xcodegen) only if the repo has project.yml and no committed project; CocoaPods/Bundler only if the repo uses them.
- Build Keychain: the host uses ~/Library/Keychains/agent-team.keychain-db, unlocked via AGENT_TEAM_MAC_KEYCHAIN_PASSWORD in ~/.agent-team/mac-build-host.env (mode 600). In an interactive SSH session unlock it first: . ~/.agent-team/mac-build-host.env && security unlock-keychain -p "$AGENT_TEAM_MAC_KEYCHAIN_PASSWORD" ~/Library/Keychains/agent-team.keychain-db ; unset AGENT_TEAM_MAC_KEYCHAIN_PASSWORD. Define KC and SVC variables in the same shell: KC=~/Library/Keychains/agent-team.keychain-db ; SVC=com.openai.agent-team.remote-build.
- A busy Mac (simulators, leftover builds) can show load averages above 100; check ps for stray xcodebuild before blaming the project.`;

const credentials = `CREDENTIALS AND SIGNING IDENTITIES (user-only; you give the exact steps, never see values)
Concepts: Apple Development certificate = run on the user's own devices. Apple Distribution certificate = App Store. With an App Store Connect API key of role ADMIN, Xcode can create/manage the Distribution certificate and profile in the cloud during export (-allowProvisioningUpdates), so no local Distribution identity is needed. An App Manager key is enough to UPLOAD but NOT to create cloud-managed distribution certificates ('Cloud signing permission error' + 'No profiles for <bundle id>'). Least privilege afterwards: use an App Manager key for uploads and revoke the Admin key (later exports may need Admin again).
Create the key: App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys > +. Download the .p8 immediately (Apple allows one download). Note Key ID (also in the AuthKey_<KEYID>.p8 file name) and Issuer ID. Keep a backup in a password manager.
Store it in the build Keychain (on the Mac; names are examples and must match 'npm run ios -- settings'):
  KC=~/Library/Keychains/agent-team.keychain-db ; SVC=com.openai.agent-team.remote-build  (then unlock as in mac-setup)
  security add-generic-password -U -a asc-key-id -s "$SVC" -w "<KEYID>" "$KC"
  security add-generic-password -U -a asc-issuer-id -s "$SVC" -w "<ISSUER-UUID>" "$KC"
  B64=$(/usr/bin/base64 -i ~/Downloads/AuthKey_<KEYID>.p8 | tr -d '[:space:]') ; security add-generic-password -U -a asc-key-p8-b64 -s "$SVC" -w "$B64" "$KC" ; unset B64
  presence check (prints no values): for n in asc-key-id asc-issuer-id asc-key-p8-b64; do security find-generic-password -a "$n" -s "$SVC" "$KC" >/dev/null 2>&1 && echo "$n: present" || echo "$n: MISSING"; done
Rules learned: the keychain path must be the LAST argument and -w must carry its value (BSD getopt stops at the first positional; a bare -w only prompts when no keychain is named). Use /usr/bin/base64 -i (Homebrew GNU base64 has no -i). Do not use 'read' inside a pasted multi-line block: it swallows the next pasted line. 'User interaction is not allowed' means the build keychain is locked in this session: unlock it.
Then the user runs: npm run ios -- settings --repo <path> --team <TEAMID> --api-key-id-secret asc-key-id --api-issuer-secret asc-issuer-id --api-key-secret asc-key-p8-b64
Importing a certificate into the build keychain (rarely needed with cloud signing): export a .p12 from Keychain Access (login keychain > My Certificates), then security import <file>.p12 -k "$KC" -P <p12 password> -T /usr/bin/codesign -T /usr/bin/security, then security set-key-partition-list -S apple-tool:,apple: -s -k <keychain password> "$KC". The user types passwords; delete the .p12 afterwards.
Team ID: developer.apple.com > Membership details (10 characters). It is an identifier, not a secret; the Apple Development certificate's parenthesised id is NOT necessarily the Team ID.`;

const signingExport = `ARCHIVE, EXPORT, UPLOAD (each needs the user's permission flag; verify each result)
1. ios_release_preflight shows the exact commands and what is blocked; dry runs touch nothing.
2. archive: needs signing permission, Team ID, an app target with bundle id/version/build. It is signed with the Development identity first; that is normal. Success = archive exists AND its bundle id, version and build match the project.
3. export (method app-store-connect, destination export; never uploads): needs a verified archive from the SAME code. First export with an Admin key creates the Distribution certificate/profile in the user's Apple account via cloud signing: tell the user that is an account-visible action before you run it.
4. upload with validateOnly=true first (contacts Apple, creates no build); then upload. Needs upload permission and the three mapped secrets. Success = Apple's tool prints UPLOAD SUCCEEDED and a Delivery UUID. The tool cannot query processing; the user checks App Store Connect > TestFlight until the build shows Ready to Submit, then selects it on the version page.
5. After a successful upload recommend: revoke upload permission, swap the Admin key for an App Manager key, back up the .p8, delete it from Mac Downloads.
Evidence is tied to the code's CONTENT (not the commit, line endings, release/ or docs/). Any code change makes build/test/archive evidence stale: rerun. Build numbers must increase for every upload (ios_prepare_release increment-build).`;

const appFixes = `APP BUGS THAT SHOWED UP ONLY WHEN RUNNING ON iOS 26 (look for these; fix in the release workspace and re-verify)
- Letterboxed app with black bars, wrong home-screen name, orientation ignored: the project sets INFOPLIST_KEY_* settings (launch screen, CFBundleDisplayName, orientations) but the app target lacks GENERATE_INFOPLIST_FILE: YES, so Xcode ignores them. With a hand-managed Info.plist (XcodeGen 'info: path') add GENERATE_INFOPLIST_FILE: YES to the app target's settings.
- Switching tabs pops back to the previous screen: a TabView screen pushed onto a NavigationStack whose tabs each create their OWN NavigationStack. Remove the nested stacks (use the outer stack), and move any search/sort/filter controls into the screen's own content, because toolbar/searchable items of tab content are not shown in the outer navigation bar.
- Autocorrect rewriting card/product names typed into decklist-style fields: .autocorrectionDisabled() on those TextFields/TextEditors.
- Privacy manifest: only needed for required-reason APIs (UserDefaults, file timestamps, boot time, disk space, active keyboards) and tracking/analytics SDKs. CoreData alone does not need it. Test targets do not count.
- Debug-only code must sit under #if DEBUG; no http:// or local/dev endpoints, ATS bypass, or get-task-allow in release.
Always add a regression check (unit or UI test) for a fix when practical, then rerun build-simulator and test-simulator.`;

const screenshots = `SCREENSHOTS (automated; the user only uploads them)
Required sets: iPhone 6.9-inch (1320x2868, also 1290x2796, 1260x2736) and, when App Store Connect asks for 'iPhone with Dynamic Island (medium display)', the 6.3-inch class (1206x2622, also 1179x2556). Landscape variants are the same sizes swapped. Opaque PNG, no alpha, 1 to 10 per set. iPad 13-inch only if the app supports iPad (set TARGETED_DEVICE_FAMILY: "1" for iPhone-only). Confirm current sizes with web_search / App Store Connect > screenshot specifications.
Method: add a UI test target (XcodeGen: type bundle.ui-testing, dependency on the app, GENERATE_INFOPLIST_FILE: YES, and add it to the scheme's test targets). The test must SKIP itself unless CAPTURE_SCREENSHOTS == 1 (try XCTSkipUnless in setUp) so normal runs are unaffected. The host sets it by running xcodebuild with TEST_RUNNER_CAPTURE_SCREENSHOTS=1 (xcodebuild forwards TEST_RUNNER_-prefixed variables to the test process with the prefix removed); captureScreenshots=true does that for you. Save shots with XCUIScreen.main.screenshot() into XCTAttachment, name '01-name', lifetime .keepAlways.
Run: ios_run_operation test-simulator with captureScreenshots=true and simulator='iPhone 17 Pro Max' (6.9) then again with 'iPhone 17 Pro' (6.3); then ios_prepare_release collect-screenshots (dryRun=false) which writes opaque, correctly sized files to release/screenshots/<class>/.
UI-test tips for iOS 26: the tab bar floats and may cover list rows; tap items by their visible text with .firstMatch (labels can appear twice); the simulator keeps app data between runs, so delete existing sample data first; retry tapping a text field until hasKeyboardFocus is true before typeText; disable autocorrect in the app's input fields; use real network only if the app needs it for sample data; put a failure message with app.debugDescription (truncated) when the screen is not what you expect.
Always LOOK at the collected images (read the files) before telling the user they are good: check for letterboxing, cut-off lists, wrong state, secrets, or third-party content that needs a disclaimer.
Upload location for the user: App Store Connect > the app > iOS App Version > Product Page Information > tab 'App Previews and Screenshots' > choose the display size section > drag the files in order > Save.`;

const appStoreConnect = `APP STORE CONNECT: WHAT THE USER FILLS IN (Hollis prepares the exact values from release/metadata.json; never enters them)
- Create the app record first: My Apps > + > New App, with the exact bundle ID (register the identifier in the developer portal if it is not listed). Upload fails without it.
- iOS App Version page (Prepare for Submission): screenshots (above), Description (up to 4000), Keywords (up to 100, comma separated; do not use others' trademarks), Support URL (required), Marketing URL (optional), Promotional Text (optional), Copyright (required, e.g. '2026 Name'), Version (prefilled), What's New (not shown for a first version), Build (select after processing), App Review Information (contact name, email, PHONE - enter here, never in a public repo; demo account only if sign-in exists; notes).
- App Information: name, subtitle (30), category, Privacy Policy URL (required).
- App Privacy: the user answers truthfully; from code facts you can suggest (for example 'Data Not Collected' only if the app has no analytics/SDKs, no accounts and sends nothing about the user), but it is their declaration.
- Ratings and Reviews: age-rating questionnaire. The computed rating sets a minimum; a higher override is allowed.
- Pricing and Availability: price tier and countries.
- 'Unable to Add for Review' banner lists every missing item; relay it exactly.
- After processing, TestFlight shows the build; 'Ready to Submit' means processed and no compliance question outstanding ('Missing Compliance' means ITSAppUsesNonExemptEncryption is not set; the user must decide it).
- Add for Review is the point of no return and is always the user's click.`;

const compliance = `COMPLIANCE AND LEGAL (give facts and options; the user decides and signs off; none of this is legal advice)
- Export compliance: scan the code (CryptoKit, CommonCrypto, OpenSSL, custom crypto, third-party SDKs, ATS exceptions). If the app only uses HTTPS/TLS and OS-provided encryption it is generally treated as exempt, which corresponds to ITSAppUsesNonExemptEncryption = false in the app's Info.plist (XcodeGen: info.properties). Set it ONLY after the user decides, record the decision in release/export-compliance.md, and tell the user to confirm Apple's current wording and any country-specific rules. Any custom or third-party cryptography changes the answer.
- Privacy policy: build it from verified code facts (what is stored locally, which hosts receive what, SDKs, permissions) in plain language: summary, data stored on device, network use and third parties (link the third party's own policy, which the user supplies), children (user decides; a common honest answer is 'not directed at children under 13' when nothing is collected), rights and choices, change notice, effective date, publisher name and contact email. Do not add a home address or phone unless the user asks. Mark every legal choice for the user.
- Support page: contact email, honest response time, FAQs taken from verified app behavior (read the UI code; do not describe features that do not exist; re-check after UI changes), reporting steps with app version/build.
- Third-party IP (for example trading-card, brand or character content): add an 'unofficial, not affiliated with or endorsed by <owner>' notice to the listing description and support page, name the owner's property, credit data providers, and point to the owner's fan/content policy; do not quote that policy; the user checks it. Keep others' trademarks out of the keywords field.
- Never publish a policy or notice the user has not read.`;

const publishing = `PUBLISHING PRIVACY AND SUPPORT PAGES (GitHub Pages; the user performs the outward steps)
- Create docs/index.md, docs/privacy.md, docs/support.md in the release workspace. Each page starts with front matter ('---', 'layout: default', 'title: ...', '---') and docs/_config.yml has 'theme: jekyll-theme-minimal'. Keep release/ copies as the source and regenerate docs/ copies when they change; they must match.
- User steps: commit and merge to the default branch (workshop Git panel or git), make sure the repository is public, then GitHub > Settings > Pages > Deploy from a branch > default branch > /docs. The URLs are https://<user>.github.io/<repo>/privacy and /support. Pages takes a few minutes; verify with web_fetch that both return the expected text before telling the user to paste them into App Store Connect.
- If Pages is served from a non-default branch, the user must keep that branch until Pages is switched.`;

const troubleshooting = `TROUBLESHOOTING (symptom -> cause -> fix). When a symptom is not here, use web_search with ONLY the error text.
- 'database is locked ... two concurrent builds' -> a stray xcodebuild holds the shared cache on the Mac -> run ios_mac_maintenance diagnose, then stop-stray-builds and clear-build-cache (manual equivalent on the Mac: pkill -f xcodebuild ; pkill -f XCBBuildService ; rm -rf ~/.agent-team-builder/cache/DerivedData) ; do not run two builds at once.
- failureClass verification, 'no completion marker' / 'exited 0 but ... not counted' -> the command ran but proof was missing; read the raw output tail in the result; never override.
- 'Cloud signing permission error' + 'No profiles for <bundle id>' -> API key role is not Admin -> create an Admin key (credentials topic) and re-store secrets.
- 'missing Xcode-Username' -> harmless (no Apple ID in Xcode) when an API key is used.
- 'User interaction is not allowed' (security import/add) -> build keychain locked in this session -> unlock it first.
- security add-generic-password prints usage -> wrong argument order or empty KC/SVC variables -> define KC/SVC, put -w "<value>" before the keychain path, keychain last.
- 'base64: unknown option i' -> GNU base64 first on PATH -> use /usr/bin/base64 -i.
- Pasted command lines wrap or break -> give short separate lines, avoid long one-liners, avoid read -p in pasted blocks.
- Readiness: Xcode < 26 -> upgrade (mac-setup). 'Distribution signing identity: none' -> expected with cloud signing; only matters if export reports a signing-identity error.
- Archive signed with 'Apple Development' -> normal; export re-signs for the App Store.
- Audit 'no verified run recorded for this tree' -> the code content changed (or evidence predates the fix) -> rerun build-simulator and test-simulator. Edits to release/ and docs/ and line endings do not count as code changes.
- Upload 'bundle version must be higher' / duplicate-build -> increment-build, rebuild, archive, export, upload.
- 'You must upload a screenshot for iPhone with Dynamic Island (medium display)' -> upload the 6.3-inch set (screenshots topic).
- 'The dimensions of one or more screenshots are wrong' -> file is in the wrong display-size slot; try the other set.
- Simulator UI test fails typing: 'no keyboard focus' -> retry tap until hasKeyboardFocus; 'multiple matching elements' -> use .firstMatch and clean leftover data.
- Tool result silent or unparsable -> redaction bug class; the CLI now redacts values, not JSON text; report the raw result file under ios-runs.
- GitHub Pages 404 right after enabling -> wait for the Pages build (a few minutes), confirm branch and /docs folder.
- Review rejection reasons arrive by email/App Store Connect Resolution Center: ask the user to paste the text, then diagnose with the app-fixes and compliance topics.`;

const nextRelease = `NEXT RELEASE CHECKLIST
1. ios_open_release_workspace; ios_prepare_release increment-build (dryRun=false) and, if needed, set-marketing-version; update 'What's New' in release/metadata.json (and review notes if behavior changed).
2. Re-read the UI code and refresh FAQ/description text that mentions changed behavior; regenerate docs/ pages; commit with ios_commit_release_changes; ask the user to merge.
3. generate-project, build-simulator, test-simulator; screenshot runs again if the UI changed; ios_release_audit.
4. Ask the user to confirm signing permission, then archive, export, upload validateOnly, upload (needs upload permission).
5. The user selects the build in App Store Connect, edits What's New, completes any new questions, and clicks Add for Review.
6. Afterwards recommend revoking upload permission again.`;

export const PLAYBOOK: PlaybookTopic[] = [
  { id: "overview", title: "End-to-end flow and who does what", text: overview },
  { id: "mac-setup", title: "Mac, Xcode and keychain setup", text: macSetup },
  { id: "credentials", title: "API keys, certificates, secret storage", text: credentials },
  { id: "signing-and-export", title: "Archive, export and upload", text: signingExport },
  { id: "app-fixes", title: "App bugs found by running on iOS 26", text: appFixes },
  { id: "screenshots", title: "Screenshots: sizes, capture, upload", text: screenshots },
  { id: "app-store-connect", title: "What the user enters in App Store Connect", text: appStoreConnect },
  { id: "compliance-and-legal", title: "Export compliance, privacy policy, support, IP notices", text: compliance },
  { id: "publishing-pages", title: "Publishing privacy/support pages", text: publishing },
  { id: "troubleshooting", title: "Symptom to fix table", text: troubleshooting },
  { id: "next-release", title: "Checklist for the next version", text: nextRelease },
];

export function playbookTopic(id: string): PlaybookTopic | undefined { return PLAYBOOK.find((topic) => topic.id === id); }
export function playbookIndex(): string { return PLAYBOOK.map((topic) => `${topic.id}: ${topic.title}`).join("\n"); }
