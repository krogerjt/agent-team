# Agent Team

A portable TypeScript agent team. The original text pipeline uses Researcher, Reviewer, and Lead. The coding workflow can also run a seven-person team (plus Hollis, an on-demand iOS release engineer), with each persona choosing its own model provider through local configuration.

## Quick start

Requires Node.js 22 or newer.

```powershell
npm install
npm start -- "Design an approach for adding rate limiting to an ASP.NET API."
```

The default `mock` provider exercises the full pipeline without credentials. Its output is deliberately synthetic and is not useful research. Run `npm test` and `npm run typecheck` to verify the local code.

## Use real models

Copy `.env.example` to `.env` and set each role's provider and model. For example:

```dotenv
RESEARCHER_PROVIDER=anthropic
RESEARCHER_MODEL=your-claude-model-id
REVIEWER_PROVIDER=openai
REVIEWER_MODEL=your-openai-model-id
LEAD_PROVIDER=bedrock
LEAD_MODEL=your-bedrock-model-id
```

Set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for those providers. Bedrock uses the standard AWS SDK credential chain and region configuration, such as `AWS_PROFILE` and `AWS_REGION`. Model IDs must be available to your account and region. You can also set `OPENAI_MODEL`, `ANTHROPIC_MODEL`, or `BEDROCK_MODEL` as a default for roles using that provider; a role-specific model takes precedence.

Keep `.env` local. The repository ignores it and all other `.env.*` files except `.env.example`. No API call is made in mock mode.

## Scope

The original `npm start` command is a sequential text pipeline. Its personas do not browse, execute code, or use external tools. A live provider call may incur usage charges. The provider interface in `src/core/provider.ts` keeps the orchestration independent of the SDKs.

## Work on a repository

Commit your starting state, then run:

```powershell
npm run code -- --repo C:\path\to\your\repo --task "Make a small, specific code change"
```

The coding command requires a clean Git repository with a commit. It creates a sibling worktree on a `codex/` branch, lets Researcher inspect, Lead patch, and Reviewer assess the diff and checks. It leaves the worktree and its uncommitted changes in place for you to inspect. The command never commits, pushes, or deletes the worktree.

Automatic checks include Node `test` and `typecheck` scripts, one root .NET solution or project, Python pytest or unittest discovery, and tracked Xcode projects or workspaces. For Xcode, the runner prefers a single workspace, discovers shared schemes, infers the Apple platform from the project, and runs an unsigned simulator or macOS build. When a shared scheme contains test targets, it also selects an available simulator and runs the scheme's tests. Apple checks use full Xcode locally on macOS or the configured Mac Build Host on Windows. For Node repositories with a lockfile, the runner uses `npm ci --ignore-scripts` in the worktree before checks. A missing tool or undetected check is reported, not counted as a pass. Model tools support repository file listing, reading, literal search, exact text patches, image inspection and PNG creation; team workers can request detected checks but cannot submit arbitrary shell commands.

The runner removes credential-like environment variables, including API keys, before starting repository checks. Checks are still code supplied by the selected repository, so choose repositories you trust.

### Use a Mac as a remote Xcode builder

Root XcodeGen specs (`project.yml` or `project.yaml`) with declared application targets/shared schemes are detected even before a project has been generated. The runner generates the project on the Mac, then builds and runs declared simulator tests. Install XcodeGen on the Mac when needed (`brew install xcodegen`); SSH builds include standard Homebrew paths on Intel and Apple Silicon Macs.

The Windows workshop can send Apple checks to a Mac without keeping repository clones there. On the Mac, install and initialize full Xcode, install a simulator runtime, enable **Remote Login**, and add your Windows SSH public key. Confirm that `ssh user@mac-host` works from Windows without a password prompt.

In the workshop, open **Options → Mac Build Host**. Enter the SSH alias or `user@host`, test the connection, and enable it. The readiness panel checks macOS, Xcode, simulators, Keychain access, archive tools, and free space. For each check pass, the runner uploads the exact non-ignored worktree to a disposable directory, reuses only build caches, streams Xcode output back, retrieves XCTest summaries and screenshot attachments, and removes the uploaded source.

Before testing the host, create a dedicated Keychain on the Mac and configure its password in a Mac-only file. For example, create `~/Library/Keychains/agent-team.keychain-db` with Keychain Access or the `security create-keychain` command, then create `~/.agent-team/mac-build-host.env` with mode `600` containing:

```sh
AGENT_TEAM_MAC_KEYCHAIN_PASSWORD='use-your-local-build-keychain-password'
# Optional override:
# AGENT_TEAM_MAC_KEYCHAIN_PATH="$HOME/Library/Keychains/agent-team.keychain-db"
```

The Mac Build Host test checks that this dedicated **Agent Team Build Keychain** exists, unlocks it over SSH, and can read it. It reports a missing Keychain or password configuration with the required initialization step. The helper locks it again after 15 minutes. Do not commit the Keychain or the configuration file. The normal macOS login Keychain is not changed.

The same panel stores a per-repository preparation command such as `bundle exec pod install` and maps environment variables to secrets in the Agent Team Build Keychain. Secret values travel over SSH only while being saved; build commands resolve them on the Mac, and only mapping names remain in Windows settings. Keep the Mac powered, awake, and reachable while goals are running.

Agents can use `inspect_build_environment` in desk chats and runs to inspect repository checks and Mac readiness. Workers also get `run_checks` during implementation to verify their exact worktree using the host's existing check runner. Required checks that are unavailable automatically go to Piper for environment diagnosis, which is recorded in the blocked task and Piper's journal. Piper reports the setup required in Workshop Options; OS permissions and secret values are still configured through the existing UI or on the Mac. A green readiness test is not a successful project build.

### PNG artwork and app icons

Workers have `create_png` to render an existing SVG, PNG, JPEG or WebP into an opaque PNG using Sharp locally on Windows or macOS. They can create new SVG artwork with `apply_patch`, then render it. For Apple app icons, use 1024×1024 dimensions and an opaque `#RRGGBB` background; conversion preserves aspect ratio with padding and removes the alpha channel. The tool validates format, dimensions and opacity before saving inside the worktree. `inspect_image` lets workers and reviewers inspect binary asset metadata. Asset catalog references still need to be patched to the PNG filename. SVGs must be self-contained; internal gradient references are supported, external resources are rejected.

For new AI artwork, `generate_png` calls the OpenAI Image API and saves an opaque 1024×1024 PNG. Configure `OPENAI_API_KEY` and `AGENT_TEAM_IMAGE_MODEL` in the host's local `.env` with a supported GPT Image model available to your account. Image generation incurs API charges; SVG conversion requires neither credentials nor an image model. Desk chats remain read-only and cannot generate or write assets. Restart the workshop after updating tools, then resume the blocked goal so Wren receives the new capabilities.

## iOS release workflow (Hollis)

Hollis is the team's iOS release engineer. Chat with Hollis from the workshop (or `npm run team -- ask --run <run> --persona hollis --message "..."`) and ask to take an iOS repository to the App Store Connect finish line. Hollis is the only persona given the `ios_*` tools, which keeps the other agents' context small. The tools are typed and constrained: there is no arbitrary shell, every argument is validated, and every result is structured JSON plus a short report grouped into **passed / failed / pending / blocked**. The same operations are available from the command line:

```powershell
npm run ios -- discover   --repo C:\path\to\ios-repo
npm run ios -- readiness  --repo C:\path\to\ios-repo
npm run ios -- audit      --repo C:\path\to\ios-repo
npm run ios -- status     --repo C:\path\to\ios-repo --recheck
npm run ios -- preflight  --repo C:\path\to\ios-repo      # dry run of archive/export/upload
```

### Workflow

| Step | What happens | Who/what is needed |
| --- | --- | --- |
| discover | Finds the Xcode project/workspace or XcodeGen spec, app target, schemes, bundle ID, version, build number, deployment target, icons, test targets, signing and release configuration, and privacy/support/App Store metadata files. Facts, missing items, warnings and blockers are reported separately; nothing is guessed. | Nothing |
| readiness | Checks the Mac: macOS, Xcode 26+, command-line tools, XcodeGen when the project needs it, simulator runtimes, `xcodebuild`/`xcrun`/`altool`, the build Keychain, distribution/development signing identities, provisioning profiles, a physical iPhone, free disk. Each failure comes with the exact fix. | A Mac Build Host |
| prepare | Increment the build number, set the marketing version (only when asked), generate release metadata/privacy/support/review-note/export-compliance starters, a submission checklist and screenshot guidance. File changes are dry-run unless `dryRun=false`, and templates never overwrite existing files. | You fill in every `[[REQUIRES USER INPUT]]` value |
| generate-project, build-simulator, test-simulator | XcodeGen, an unsigned simulator build, and XCTest on an available simulator, with XCTest summaries, screenshot attachments and failure diagnostics saved under the repository's data folder. | A Mac Build Host |
| audit | Bundle ID, versions, build-number status, signing, icons, debug-only settings and development endpoints (outside `#if DEBUG`), tests, privacy behavior vs. usage strings and privacy manifest, support/privacy files, metadata completeness, export compliance, App Review notes, screenshots by exact size, physical-device testing. | Recorded results from earlier steps |
| archive, export | `xcodebuild archive`, then `-exportArchive` (export only, `app-store-connect` method). | Your signing permission, Apple Developer certificate/profile or API key |
| upload | `xcrun altool --upload-app` (or `--validate-app` with `validateOnly`). Success is reported only when Apple's tool reports it. | Your upload permission and an App Store Connect API key |
| submit | **Always manual.** Click *Submit for Review* in App Store Connect yourself. No tool, command or permission exists for it. | You |

A build, test, archive or upload is reported as `status: "success"` only when the command exited 0 **and** its expected output was verified: a `BUILD SUCCEEDED` line plus an `.app`; an XCTest summary with tests run and none failed; an `.xcarchive` whose bundle ID, version and build match the project; a non-empty `.ipa`; Apple's success message. Readiness checks never count as success. If a command exits 0 but verification fails, the result is `failed` with `failureClass: "verification"`.

Every operation records the exact worktree it used (commit, dirty flag and a content hash of the uploaded files that ignores `release/` and `docs/`). An archive or export is only used if it was built from the current tree. Temporary Mac-side source copies and API-key files are removed after each operation, success or failure; only build caches and archives remain.

### Mac Build Host setup

Everything above builds on the existing **Options → Mac Build Host** panel (see "Use a Mac as a remote Xcode builder"): enable Remote Login on the Mac, add your SSH key, create the dedicated Agent Team Build Keychain and its `~/.agent-team/mac-build-host.env`, and enable the host. Then:

1. Install **full Xcode 26 or later**, open it once, accept the license, and run `sudo xcode-select -s /Applications/Xcode.app`. Install an iOS simulator runtime (Xcode → Settings → Components).
2. Install XcodeGen when the repository has a `project.yml`/`project.yaml` and no committed project: `brew install xcodegen`. Install CocoaPods or Bundler if the repository needs them and set the per-repository preparation command.
3. For signing, import your **Apple Distribution** certificate (and an Apple Development certificate for device testing) with its private key into the Agent Team Build Keychain, then allow tools to use it unattended: `security set-key-partition-list -S apple-tool:,apple: -s -k "<keychain password>" ~/Library/Keychains/agent-team.keychain-db`. Do this by hand on the Mac; the password never goes through the agent.
4. For uploads and automatic provisioning, create an **App Store Connect API key** (Users and Access → Integrations) and store three secrets in the build Keychain by name, using the existing secret UI (Options → Mac Build Host): the key ID, the issuer ID, and the `.p8` file **base64-encoded on one line** (`base64 -i AuthKey_XXXX.p8`). Then map their names, never their values:

```powershell
npm run ios -- settings --repo C:\path\to\ios-repo --team ABCDE12345 `
  --api-key-id-secret asc-key-id --api-issuer-secret asc-issuer-id --api-key-secret asc-key-p8-b64
```

The values are read from the Keychain on the Mac at command execution time, the `.p8` is written to a private temporary directory that is deleted on exit, and anything that looks like a key, token or issuer ID is redacted before output returns to Windows or to a model.

### Permissions and safety rules

- **Signing, upload and submission are three separate states.** Signing (`build-release`, `archive`, `export`, `install-device`) and upload are disabled until *you* grant them: `npm run ios -- grant signing --repo <path>` and `npm run ios -- grant upload --repo <path>` (revoke with `revoke`). Agents can read these flags but have no tool that sets them. Submission for App Review has no permission because it is never automated.
- Export never uploads, and upload only accepts an export built from the current tree and a build number above the last verified upload.
- Use `ios_release_preflight` (or `--dry-run` on any operation) to see exactly what would run. Dry runs sign, archive, upload and change nothing, and do not contact the Mac.
- Apple passwords, API keys, certificates, provisioning profiles and private keys are never stored in the repository, printed, or put in chat. Only Keychain secret *names* are configured.
- The agent does not invent legal text, URLs, copyright owners, pricing or Apple account details. Those values are `[[REQUIRES USER INPUT]]` placeholders, and the audit reports files that still contain them as **pending**.

### Resuming after a blocker

Each step's result is saved per repository. When something is blocked (a missing permission, Team ID, credential, signing identity, placeholder…), the status tool names the blocker and the exact fix. After you fix it, ask Hollis to continue or run `npm run ios -- status --repo <path> --recheck`: it re-inspects the project and Mac, returns only the steps whose blockers are now resolved to *pending*, and reports the next step.

### What still needs you

- **Apple Developer / App Store Connect access:** Developer Program membership and agreements, the App Store Connect app record for the bundle ID, certificates and the API key, the App Privacy questionnaire, age rating, pricing, and the *Submit for Review* click. The tool cannot query App Store Connect processing or review state, so its result says so instead of guessing; check TestFlight/App Store Connect after an upload.
- **A physical iPhone:** `install-device` needs an unlocked, trusted iPhone connected to the Mac (Developer Mode on) and a development signing identity. Simulator results never satisfy the audit's physical-device item.
- **Screenshots:** the agent lists required classes and sizes (iPhone 6.9″, plus iPad 13″ if iPad is supported) and gives capture guidance; real screenshots go in `release/screenshots/<class>/` as opaque PNGs. Confirm current sizes in App Store Connect.

Upload uses Apple's `altool`; if Apple retires it, only `uploadCommand` in `src/ios/commands.ts` needs to change.

## Seven-person team

| Persona | Responsibility |
| --- | --- |
| Marlow | Inspect the repo, plan up to four tasks, and summarize the result |
| Juniper | Research each task in the codebase |
| Kit | Implement and test general code tasks |
| Wren | Implement interface tasks |
| Rowan | Refactor assigned code and review other workers |
| Tove | Check task acceptance and prepare shared project memory |
| Piper | Set up and repair the local web preview cookbook |
| Hollis | On demand, not in run plans: iOS release engineer (discover, Mac readiness, simulator checks, release audit, archive/export/upload with your permission) |

Start a goal with:

```powershell
npm run team -- run --repo C:\path\to\your\repo --goal "Add a small feature"
```

The command prints a run directory. Use it to inspect the task wall, reviewer notes, checks, and final diff:

```powershell
npm run team -- status --run "<run-directory>"
npm run team -- review --run "<run-directory>"
npm run team -- events --run "<run-directory>"
```

Marlow creates a task plan with dependencies. Tasks execute in dependency order. Each coding worker gets a separate worktree and local branch. Approved task branches advance a staging branch, while your original checkout stays at its starting commit. The run state, plan, and event log are saved under `~/.agent-team/repos/<repo>/runs/`. Tove's memory note is added to the repo's shared library only after you merge.

After reviewing the diff, explicitly merge the staging branch into your original checkout:

```powershell
npm run team -- merge --run "<run-directory>"
```

Merge requires the original checkout to be clean and still at the starting commit. It is a local fast-forward; no push occurs. A task with unresolved check, review, or QA issues remains blocked in its worktree and cannot be merged through this command. Worktrees and logs remain available for inspection.

If a worker asks a question with `NEEDS_INPUT:` or a task remains blocked, inspect `status` and `review`, then provide guidance to resume that task in its existing worktree:

```powershell
npm run team -- answer --run "<run-directory>" --text "Your decision or repair guidance"
```

You can ask a named persona a read-only question about a run, or inspect shared memory directly:

```powershell
npm run team -- ask --run "<run-directory>" --persona juniper --message "Which files matter most?"
npm run team -- library --repo C:\path\to\your\repo
```

`MARLOW_*`, `JUNIPER_*`, `KIT_*`, `WREN_*`, `ROWAN_*`, `TOVE_*`, and `PIPER_*` in `.env` can select providers and models individually. If omitted, they inherit the existing Lead, Researcher, and Reviewer settings shown in `.env.example`. Team tasks currently run in dependency order.

# Workshop UI

Start the local workshop for this repository:

```sh
npm run ui -- .
```

Open the address printed by the server (by default `http://127.0.0.1:4173`). The workshop shows one block-style desk per agent (including Hollis), the goal/task wall, activity, review, and an answer box when a task needs your input. Click an agent to chat, edit their personal traits and pinned memory, inspect their work journal, or choose their provider and model. The app keeps profiles and chats locally under `~/.agent-team/repos/<repository>/personas/`; API keys remain in `.env`. Model changes apply to the next goal or chat. The UI binds to your own computer only.

Each desk also has a **Review** tab. A performance review runs two exercises tailored to that agent's role, asks a second agent to score the answers, and stores the score, feedback, reflection, and a bounded self-improvement note. The latest note becomes part of the reviewed agent's context on future work. Reviews require real models for both the selected agent and its reviewer; demo-mode mock providers do not invent scores.

The browser needs the UI server running. A new goal still requires a clean committed checkout. A run can be merged locally from the review screen only while the original checkout is at the commit where that run started.

## Local Test Bench

The repository control in the workshop header opens recent local projects or adds a Git repository by folder path. Each project loads its own goals, personal desks, and library. Recent paths are saved outside Git in `~/.agent-team/workshop.json`. Switching stops local previews and waits until current agent work has finished. The selected project is shared by browser tabs connected to this workshop server; stale tabs must refresh before they can change anything.

**Git tools** lets you review local changes, select files, and save a local commit with your own message. The build review lists merge blockers and offers **Update run to latest code** when your checkout has advanced. Updates combine the build with your current committed code in a new worktree, preserving the original build and checkout. For conflicts, choose one whole file version in the review, or edit and stage a resolution in the update worktree. **Finish update and rerun checks** saves the resolution and runs detected checks again; failures keep merging blocked. Updated web interfaces require a fresh Test Bench review. Review the combined diff before merging. The Git tools window also has a **branch selector** (local branches, plus remote branches that you can check out as tracking branches) and a **New branch** box. Switching branches requires that tracked files have no unsaved changes; creating a branch carries changes in progress to the new branch. **Pull** fast-forwards the current branch from its remote and refuses to merge or rebase diverged history. **Push** sends the current branch to its remote, publishing it with an upstream the first time, and never forces. Both wait for running work to finish. Run and update buttons in the build review never push, and `.env` files cannot be selected for a workshop commit.

For a web repository, Piper reads the staged code and saves an environment cookbook outside Git at `~/.agent-team/repos/<repository>/environment-cookbook.json`. The cookbook contains setup, build, and start commands, a local health path, and variable mappings. Piper may revise it four times after startup failures. Piper cannot edit application code. The host runs cookbook commands in the staging worktree, shows risky commands for your decision, and reports a code diagnosis if setup still fails. A missing secret appears as a prompt from Piper.

Open **Test Bench** in the workshop to see the live staged app, Piper's log and cookbook, the latest screenshot, browser steps, and Wren's review. Wren receives a screenshot when their selected model accepts images; otherwise the review says that visual verification was unavailable. Wren or the relevant worker gets one focused code fix pass for an interface issue, followed by another check and preview. Switching runs or pressing **Stop preview** ends the preview process tree. Only the selected run remains live.

The **Shared secret shelf** stores named values locally using Windows user-scoped encryption or the current user's login Keychain on macOS. The cookbook maps app variable names to those secret names; Piper receives names and redacted command output, never vault values. Preview processes receive only an explicit set of basic operating-system variables and cookbook variables. Wren receives a page screenshot and page text, so avoid showing sensitive data in the previewed interface. The local worktree separates source changes, but commands run with your local account's permissions. Use the Test Bench with repositories you trust. Edge or Chrome must be installed for browser capture and scenarios; the app checks Edge first.

## Searchable agent timelines

Each agent has an append-only personal timeline under `~/.agent-team/repos/<repository>/personas/<agent>/timeline/YYYY-MM.jsonl`. Each line has an ISO timestamp, event type, one-line summary, feature or task, affected files when known, run and task IDs, and a bounded detail. Existing run logs and older personal activity are imported on first use. These plain-text files can be searched directly with `rg`, and the workshop Journal tab has word, date, feature, and file filters.

Agents have `search_memory` and `get_memory_entry` tools. When asked about past work by feature, file, or date, they search their own timeline and read only the matching detail instead of loading an entire history into their prompt. Pinned personal memory and the shared library remain separate from this event record.

To search from the terminal:

```powershell
npm run team -- timeline --repo . --persona wren --query "checkout" --from 2025-01-01
```

## Persona model statistics

Each persona profile also keeps cumulative and monthly statistics per provider/model under `modelStats`. The workshop's **Model analytics** view compares interactions, provider calls, known input/output/total tokens, provider latency, end-to-end interaction time, tool calls, and calls where token usage was unavailable. Tool loops count every model round. Token totals are deliberately not estimated when a provider does not return usage, so unknown usage is reported separately rather than as zero. The same data is available from `GET /api/analytics` while the local workshop is running.
