# Agent Team

A portable TypeScript agent team. The original text pipeline uses Researcher, Reviewer, and Lead. The coding workflow can also run a six-person team, with each persona choosing its own model provider through local configuration.

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

Automatic checks include Node `test` and `typecheck` scripts, one root .NET solution or project, and Python pytest or unittest discovery. For Node repositories with a lockfile, the runner uses `npm ci --ignore-scripts` in the worktree before checks. A missing tool or undetected check is reported, not counted as a pass. Model tool use is limited to repository file listing, reading, literal search, and exact text patches; it cannot ask the runner to execute arbitrary commands.

The runner removes credential-like environment variables, including API keys, before starting repository checks. Checks are still code supplied by the selected repository, so choose repositories you trust.

## Six-person team

| Persona | Responsibility |
| --- | --- |
| Marlow | Inspect the repo, plan up to four tasks, and summarize the result |
| Juniper | Research each task in the codebase |
| Kit | Implement and test general code tasks |
| Wren | Implement interface tasks |
| Rowan | Refactor assigned code and review other workers |
| Tove | Check task acceptance and prepare shared project memory |

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

`MARLOW_*`, `JUNIPER_*`, `KIT_*`, `WREN_*`, `ROWAN_*`, and `TOVE_*` in `.env` can select providers and models individually. If omitted, they inherit the existing Lead, Researcher, and Reviewer settings shown in `.env.example`. Team tasks currently run in dependency order.

# Workshop UI

Start the local workshop for this repository:

```sh
npm run ui -- .
```

Open the address printed by the server (by default `http://127.0.0.1:4173`). The workshop shows six block-style agent desks, the goal/task wall, activity, review, and an answer box when a task needs your input. Click an agent to chat, edit their personal traits and pinned memory, inspect their work journal, or choose their provider and model. The app keeps profiles and chats locally under `~/.agent-team/repos/<repository>/personas/`; API keys remain in `.env`. Model changes apply to the next goal or chat. The UI binds to your own computer only.

The browser needs the UI server running. A new goal still requires a clean committed checkout. A run can be merged locally from the review screen only while the original checkout is at the commit where that run started.
