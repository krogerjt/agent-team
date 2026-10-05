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

This is a sequential text pipeline. The personas do not browse, execute code, or use external tools. A live provider call may incur usage charges. The provider interface in `src/core/provider.ts` keeps the orchestration independent of the SDKs.
