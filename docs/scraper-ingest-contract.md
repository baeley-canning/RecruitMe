# Scraper Ingest Contract

This is the contract the headless scraper (the mini-PC pulling the user's own
JobAdder / LinkedIn / SEEK candidate data) codes against. It is the authoritative
spec for the batch ingest endpoint.

> **Profiles land in the LIBRARY, UNSCORED.** No AI scoring runs at ingest. The
> recruiter scores candidates on demand later in the app. Don't expect a
> `matchScore` back from this endpoint.

---

## Endpoint

```
POST /api/ingest/candidates/batch
Content-Type: application/json
Authorization: Bearer <token>
```

Base URL is wherever the app is deployed (e.g. `https://<your-app>.up.railway.app`).

---

## Authentication

Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The plaintext token is shown **once**, when you mint it. The server stores only
its SHA-256 hash — it cannot be recovered. If lost, mint a new one.

### Minting a token

There is no UI. Run the CLI (locally, or via `railway run`):

```
node scripts/create-scraper-token.mjs <label> [orgId]
```

- `<label>` — required. Human label, e.g. `thinkcentre-scraper`.
- `[orgId]` — optional. Omit for owner-scope (the token may ingest into any
  org). Provide an org id to pin ingested profiles to that org.

The command prints the plaintext token once. Store it in the scraper's config
immediately.

Tokens can be revoked or expired (set `revokedAt` / `expiresAt` on the
`ScraperApiToken` row). A revoked or expired token returns `401`.

---

## Request body

```jsonc
{
  "profiles": [ Profile, ... ]   // min 1, max 200 per request
}
```

### Profile

| Field         | Type                                          | Notes |
|---------------|-----------------------------------------------|-------|
| `name`        | string (1..500)                               | Required. Display name. |
| `headline`    | string \| null                                | Job title / tagline. |
| `location`    | string \| null                                | Freeform location. |
| `linkedinUrl` | string \| null                                | A `linkedin.com/in/<slug>` URL. Validated; if present but not a real profile URL it is **dropped** (the row still ingests via another key). |
| `jobAdderUrl` | string \| null                                | JobAdder candidate profile URL. Must be `http(s)://…`; otherwise dropped. |
| `seekUrl`     | string \| null                                | A `seek.co.nz` / `seek.com.au` / `seek.com` profile URL. Validated; dropped if invalid. |
| `profileText` | string (min ~50 chars) \| null                | Full profile / CV text. Send `null` for a URL-only capture. If provided it must be at least 50 chars (a 422 otherwise). |
| `externalId`  | string \| null                                | Optional source-side id. **Not** a dedup key on its own — a row with only `externalId` and no URL is skipped. |
| `source`      | `"linkedin"` \| `"jobadder"` \| `"seek"`      | Optional. Informational; provenance is actually carried by which URL field is set. |

#### Identity key (dedup)

Every profile needs an **identity key** to be ingestable, because library rows
(`jobId: null`) can't be deduped by the database's `(jobId, linkedinUrl)` unique
constraint (Postgres treats NULL `jobId` as distinct). The key is, in
precedence order:

1. normalised `linkedinUrl`, else
2. normalised `jobAdderUrl`, else
3. normalised `seekUrl`.

A profile with **no valid URL** (and even if it has an `externalId`) is
**skipped** with reason `no_identity_key` — we will not create an un-dedupable
library row.

---

## Dedup behaviour

For each profile the server:

1. Cleans + normalises the URLs (dropping any that fail validation).
2. Computes the identity key (precedence above).
3. Looks up an existing **library** Candidate (same org, `jobId: null`) whose
   matching URL field equals the key.
4. **Found** → `updated`: fills in fields that were empty, and **never**
   overwrites a populated `profileText` with `null` (or a populated `headline` /
   `location` / URL with a new value). Re-ingesting is safe and idempotent-ish:
   you can re-send a profile to fill gaps without clobbering richer data.
5. **Not found** → `created`: a new library row, `source: "scraper"`,
   `status: "new"`.

Normalisation: LinkedIn → canonical `https://www.linkedin.com/in/<slug>`;
SEEK / JobAdder → query+fragment stripped, trailing slash collapsed, host
lowercased (path case preserved).

---

## Response

`200 OK` always (unless auth/body failed), even with per-row failures:

```jsonc
{
  "outcomes": [
    { "index": 0, "status": "created", "candidateId": "clx..." },
    { "index": 1, "status": "updated", "candidateId": "cly..." },
    { "index": 2, "status": "skipped", "reason": "no_identity_key" },
    { "index": 3, "status": "failed",  "reason": "..." }
  ],
  "counts": { "created": 1, "updated": 1, "skipped": 1, "failed": 1, "total": 4 }
}
```

- `status`: `"created"` | `"updated"` | `"skipped"` | `"failed"`.
- `index`: the position in the `profiles` array you sent.
- `candidateId`: present on `created` / `updated`.
- `reason`: present on `skipped` / `failed`.

### Error responses

| Status | When |
|--------|------|
| `401`  | Missing / unknown / revoked / expired bearer token. |
| `422`  | Body failed validation (missing `profiles`, empty, > 200, bad `name`, `profileText` under 50 chars, etc.). The body is `{ "error": <zod flatten> }`. |

---

## Rate limiting

There is no hard rate limit enforced at the endpoint today. Be a good citizen:

- Batch up to **200 profiles per request** (the schema max).
- Send batches sequentially, not in a parallel storm — each profile does its own
  dedup lookup + write.
- On a `5xx`, back off and retry the batch; ingest is safe to re-send (dedup
  makes re-sends fill-only updates rather than duplicates).

---

## Worked examples

### 1. A LinkedIn profile

```bash
curl -X POST https://<your-app>/api/ingest/candidates/batch \
  -H "Authorization: Bearer $SCRAPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profiles": [
      {
        "name": "Jane Doe",
        "headline": "Senior Platform Engineer",
        "location": "Auckland, New Zealand",
        "linkedinUrl": "https://www.linkedin.com/in/jane-doe-1a2b3c",
        "jobAdderUrl": null,
        "seekUrl": null,
        "profileText": "Senior platform engineer with 9 years across AWS, Kubernetes, and Terraform. Previously at ...",
        "externalId": "li-jane-doe-1a2b3c",
        "source": "linkedin"
      }
    ]
  }'
```

### 2. A SEEK profile (URL-only, no profile text yet)

```bash
curl -X POST https://<your-app>/api/ingest/candidates/batch \
  -H "Authorization: Bearer $SCRAPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profiles": [
      {
        "name": "John Smith",
        "headline": "Quantity Surveyor",
        "location": "Wellington",
        "linkedinUrl": null,
        "jobAdderUrl": null,
        "seekUrl": "https://www.seek.co.nz/profile/john-smith-abc123",
        "profileText": null,
        "externalId": "seek-abc123",
        "source": "seek"
      }
    ]
  }'
```

Both land in the library, unscored. The recruiter scores them on demand later.
