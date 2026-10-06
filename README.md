# Agent Team

A portable TypeScript agent team. The original text pipeline uses Researcher, Reviewer, and Lead. The coding workflow can also run a seven-person team, with each persona choosing its own model provider through local configuration.

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

Open the address printed by the server (by default `http://127.0.0.1:4173`). The workshop shows seven block-style agent desks, the goal/task wall, activity, review, and an answer box when a task needs your input. Click an agent to chat, edit their personal traits and pinned memory, inspect their work journal, or choose their provider and model. The app keeps profiles and chats locally under `~/.agent-team/repos/<repository>/personas/`; API keys remain in `.env`. Model changes apply to the next goal or chat. The UI binds to your own computer only.

Each desk also has a **Review** tab. A performance review runs two exercises tailored to that agent's role, asks a second agent to score the answers, and stores the score, feedback, reflection, and a bounded self-improvement note. The latest note becomes part of the reviewed agent's context on future work. Reviews require real models for both the selected agent and its reviewer; demo-mode mock providers do not invent scores.

The browser needs the UI server running. A new goal still requires a clean committed checkout. A run can be merged locally from the review screen only while the original checkout is at the commit where that run started.

## Local Test Bench

The repository control in the workshop header opens recent local projects or adds a Git repository by folder path. Each project loads its own goals, personal desks, and library. Recent paths are saved outside Git in `~/.agent-team/workshop.json`. Switching stops local previews and waits until current agent work has finished. The selected project is shared by browser tabs connected to this workshop server; stale tabs must refresh before they can change anything.

**Git tools** lets you review local changes, select files, and save a local commit with your own message. The build review lists merge blockers and offers **Update run to latest code** when your checkout has advanced. Updates combine the build with your current committed code in a new worktree, preserving the original build and checkout. For conflicts, choose one whole file version in the review, or edit and stage a resolution in the update worktree. **Finish update and rerun checks** saves the resolution and runs detected checks again; failures keep merging blocked. Updated web interfaces require a fresh Test Bench review. Review the combined diff before merging. These buttons never push to GitHub, and `.env` files cannot be selected for a workshop commit.

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
