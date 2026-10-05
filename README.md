# Agent Team

A small TypeScript pipeline with three personas: Researcher investigates a goal, Reviewer critiques the findings, and Lead writes the final answer. Each role chooses its own model provider through local configuration.

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
