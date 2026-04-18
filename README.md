# SearchDesk

SearchDesk is a recruiter execution system for IT recruiting workflows.

It is intentionally not a generic ATS. The app is centered on:

- today-mode desk workflow
- search assignments
- LinkedIn-assisted capture
- candidate cockpit
- shortlist and submission output

## v2 foundation docs

The next complete product target is documented here:

- `docs/final-product-spec.md`
- `docs/desktop-extension-architecture.md`
- `docs/ai-pipeline-design.md`
- `docs/database-schema.md`
- `docs/build-roadmap-v2.md`
- `database/searchdesk-v2.sql`

## Current testing posture

SearchDesk now starts in a clean testing state:

- no seeded recruiter identities
- no seeded searches
- no seeded candidates
- no seeded shortlists or submission packs

Testers enter their own workspace name and role at `/auth/sign-in`, and the app builds a signed session from that input.
LinkedIn-first sign-in now includes a workspace confirmation step instead of silently inventing a desk from the email domain.
Manual fallback sign-in requires work email so SearchDesk can keep a stable workspace member identity across sessions.

What persists today:

- runtime-created search assignments
- runtime-created shortlist packs
- LinkedIn capture drafts
- promoted local captured leads
- canonical candidate views built from promoted leads across searches

That runtime data is stored in:

```text
.searchdesk-runtime/workspace-store.json
.searchdesk-runtime/member-registry.json
```

## Routes

- `/auth/sign-in`
- `/today`
- `/searches`
- `/searches/[searchId]`
- `/capture`
- `/candidates`
- `/candidates/local/[leadId]`
- `/deliverables`
- `/deliverables/[shortlistId]`
- `/team`
- `/settings`
- `/settings/integrations`
- `/candidates/[candidateId]`

The live no-seed loop now runs through runtime searches, canonical candidates, search-specific candidate records, and runtime shortlist packs.

## Setup

1. Make sure Node.js 24+ is available inside Linux/WSL if you are working from the WSL filesystem.
2. Copy `.env.example` to `.env.local`.
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

If you are launching from PowerShell against `\\wsl.localhost\...`, run the commands through WSL instead of Windows `npm`, for example:

```powershell
wsl.exe --cd /home/cassius/recruitme bash -lc "npm install && npm run dev"
```

## Sign-in

Open `http://localhost:3000/auth/sign-in` and enter:

- workspace name
- your name
- your email
- your title
- your role

This creates a signed testing session. It does not load fake office users.
If you use LinkedIn-first sign-in, SearchDesk now asks you to confirm the workspace name before creating the session.

## Environment

Copy `.env.example` to `.env.local` and adjust values as needed.

For signed testing sessions:

```bash
SEARCHDESK_SESSION_SECRET=change-me-for-shared-office-use
SEARCHDESK_WORKSPACE_ACCESS_CODE=
SEARCHDESK_ALLOW_SELF_ASSIGN_OWNER=0
```

`SEARCHDESK_WORKSPACE_ACCESS_CODE` lets you require a shared office code before creating a session.
`SEARCHDESK_ALLOW_SELF_ASSIGN_OWNER=1` is required if you want the `Owner` role to appear on sign-in.
If `SEARCHDESK_SESSION_SECRET` is omitted, SearchDesk generates and stores a local secret file for this workspace under `.searchdesk-runtime/`.

For optional AI recruiter assist in capture, the recommended no-extra-cost path is local Ollama:

```bash
SEARCHDESK_AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b
```

If you want the OpenAI API instead:

```bash
SEARCHDESK_AI_PROVIDER=openai
OPENAI_API_KEY=...
SEARCHDESK_OPENAI_MODEL=gpt-5.4-mini
```

For LinkedIn OAuth:

```bash
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
LINKEDIN_REDIRECT_URI=http://localhost:3000/api/integrations/linkedin/callback
SEARCHDESK_LINKEDIN_REMEMBER_DAYS=30
```

If those values are missing, LinkedIn login will not work. SearchDesk now shows the missing env vars and redirect diagnostics on `/settings/integrations`.

For local Ollama, install Ollama, start it, and pull the model once:

```bash
ollama pull llama3.2:3b
```

The LinkedIn slice is intentionally narrow:

- official OAuth account linking for the signed-in tester
- remember-me support through an HTTP-only cookie
- no scraping
- no partner-only talent API integration in this scaffold

## Verification

```bash
npm run lint
npm run build
```

## Quick smoke test

1. Open `/auth/sign-in`.
2. Enter a workspace name and your own testing identity.
3. Open `/today` and confirm the workspace is blank but ready for the first-run flow.
4. Open `/searches` and create a real search assignment.
5. Open `/capture?mode=linkedin&searchId=<your-search-id>`.
6. Paste a LinkedIn URL plus copied profile text, or use `Use sample profile`, then `Parse into draft`.
7. Promote the draft into a workspace candidate.
8. Open `/deliverables?searchId=<your-search-id>` and create a shortlist pack.
9. Confirm the generated pack opens at `/deliverables/[shortlistId]`.
10. If you are sourcing on LinkedIn, load the Opera/Chromium browser companion from `browser-companion/recruitme-opera-linkedin-capture`, then use RecruitMe's `Fetch profile` flow or the extension popup to capture visible profiles back into the app.

## Current boundaries

- auth is signed-session based, not production identity management
- runtime persistence is file-backed, not database-backed
- canonical candidates are derived from runtime leads, not stored as a separate database table yet
- integrations are intentionally narrow and do not include LinkedIn scraping or partner APIs
