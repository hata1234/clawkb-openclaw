---
name: clawkb
description: Use this skill when an agent needs to work with a ClawKB server over HTTP: register itself, obtain or use a Bearer token, upload images, create or update entries, search entries, read entry detail, or inspect plugin-backed API flows.
---

# ClawKB

## Overview

This skill is for operating ClawKB as an API client. Use it when the task is to register an agent account, authenticate with a Bearer token, upload images to MinIO through ClawKB, create or edit entries, or search and read stored knowledge.

Assume the server base URL is provided by the user. If not, ask for it. Prefer `curl` examples unless the user requests another client.

## Quick Start

1. Get a base URL, for example `http://localhost:3500`.
2. If you do not already have a token, register an agent with `POST /api/auth/register-agent`.
3. **Save the token to `~/.config/clawkb/credentials.json`** (see Credential Storage below).
4. Send authenticated requests with `Authorization: Bearer <token>`.

Example:

```bash
BASE_URL="http://localhost:3500"

curl -sS "$BASE_URL/api/auth/register-agent" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "OpenClaw Recon Agent",
    "avatarUrl": "https://example.com/agent-avatar.png"
  }'
```

Successful response fields to retain:

- `user.id`
- `user.username`
- `apiToken`
- `token.prefix`
- `token.type`

## Credential Storage

**Never rely on conversation memory for tokens.** Always persist credentials to disk and read them before each API call.

**Credential file:** `~/.config/clawkb/credentials.json`

```json
{
  "instances": {
    "default": {
      "url": "http://localhost:3500",
      "apiToken": "clawkb_...",
      "agentName": "OpenClaw Recon Agent",
      "userId": 7,
      "registeredAt": "2026-01-15T10:00:00Z"
    }
  }
}
```

### Credential workflow

1. **Before any API call:** Read `~/.config/clawkb/credentials.json`. If the file exists and has a token for the target instance, use it.
2. **First time / no credential file:** Register with `POST /api/auth/register-agent`, then handle the response:
   - If `apiToken` is returned → agent was auto-approved. Save token to `~/.config/clawkb/credentials.json`.
   - If `requiresAdminApproval: true` → save the `username` and tell the user their admin needs to approve the agent in ClawKB Settings → Users. Then poll for approval (see below).
3. **401 response:** The token may have been revoked. Re-register and update the credential file.
4. **Multiple instances:** Use the `instances` map with descriptive keys (e.g. `"work"`, `"personal"`, `"public"`).

### Approval polling (when admin approval is required)

If registration returns `requiresAdminApproval: true`, the agent has no token yet. Poll the status endpoint:

```bash
curl -sS "$BASE_URL/api/auth/agent-status?username=my-agent-name"
```

Possible responses:

- `{ "status": "pending_approval" }` → Not yet approved. Wait and retry later.
- `{ "status": "approved", "tokens": [...] }` → Approved! The `tokens` array contains `{ prefix, type, name }`. Note: the full token is NOT returned here for security — the admin receives the full token in the UI at approval time and should provide it to the agent owner.
- `{ "status": "rejected" }` → Registration was rejected.
- `{ "status": "not_found" }` → No agent with that username.

**Do NOT poll in a tight loop.** If the agent needs to wait for approval:
1. Tell the user: "Your ClawKB admin needs to approve this agent in Settings → Users."
2. Save the username to the credential file with `"status": "pending_approval"`.
3. On the next conversation where ClawKB is needed, check status once. If still pending, remind the user.

### Full registration example

```bash
# Register
RESULT=$(curl -sS "$BASE_URL/api/auth/register-agent" \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Agent"}')

# Check if auto-approved
TOKEN=$(echo "$RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r.get('apiToken',''))")

if [ -n "$TOKEN" ]; then
  # Auto-approved — save token
  mkdir -p ~/.config/clawkb
  echo "{\"instances\":{\"default\":{\"url\":\"$BASE_URL\",\"apiToken\":\"$TOKEN\"}}}" > ~/.config/clawkb/credentials.json
  echo "Ready to use!"
else
  # Needs approval
  USERNAME=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['user']['username'])")
  echo "Pending approval. Username: $USERNAME"
  echo "Ask your admin to approve in ClawKB Settings → Users."
fi
```

```bash
# Read token before use
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.config/clawkb/credentials.json'))['instances']['default']['apiToken'])")
```

## Collections

**Every entry should belong to a collection.** Do not create entries without a `collectionId` — they end up in "未歸類" (uncategorized) and create clutter.

### Listing collections

Before creating an entry, fetch the server's collection list:

```bash
curl -sS "$BASE_URL/api/collections" \
  -H "Authorization: Bearer $TOKEN"
```

Response:

```json
{
  "collections": [
    { "id": 6, "name": "Project Notes", "description": "...", "icon": "📋" },
    { "id": 9, "name": "Reports", "description": "...", "icon": "📊" },
    ...
  ]
}
```

### Choosing a collection

1. **Read the collection list** from the server — do NOT hardcode collection IDs or names.
2. **Match by semantics:** Compare the entry's topic/type against each collection's `name` and `description`.
3. **If a good match exists:** Use that collection's `id` as `collectionId`.
4. **If no match exists:** Either ask the user which collection to use, or omit `collectionId` (falls back to uncategorized). Do NOT create new collections without user approval.

### Caching collections

To avoid fetching collections on every entry creation:

1. Cache the collection list in `~/.config/clawkb/collections-cache.json` with a timestamp.
2. Refresh if cache is older than 1 hour or if a `collectionId` returns a 400/404.

```json
{
  "instances": {
    "default": {
      "fetchedAt": "2026-03-30T00:00:00Z",
      "collections": [
        { "id": 6, "name": "Project Notes", "description": "..." },
        { "id": 9, "name": "Reports", "description": "..." }
      ]
    }
  }
}
```

## Create Entries

Use `POST /api/entries`.

Required fields:

- `type`
- `source`
- `title`

**Strongly recommended fields:**

- `collectionId` — integer, from `GET /api/collections` (see Collections section above)

Common optional fields:

- `summary`
- `content`
- `status`
- `url`
- `tags`
- `metadata`
- `images`

Example:

```bash
# 1. Read token
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.config/clawkb/credentials.json'))['instances']['default']['apiToken'])")

# 2. Fetch collections (or read from cache)
curl -sS "$BASE_URL/api/collections" -H "Authorization: Bearer $TOKEN"
# → choose collectionId based on content

# 3. Create entry WITH collectionId
curl -sS "$BASE_URL/api/entries" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "report",
    "source": "nightly-recon",
    "title": "GPU cluster pricing moved lower this week",
    "summary": "Spot market pricing softened across three vendors.",
    "content": "## Notes\nObserved lower prices in APAC and US regions.",
    "status": "new",
    "collectionId": 9,
    "tags": ["gpu", "cloud-pricing"],
    "metadata": {
      "region": ["us", "apac"],
      "confidence": "medium"
    }
  }'
```

The response includes:

- entry core fields
- `author`
- `tags`
- `images`

## Edit Entries

Use `PATCH /api/entries/:id`.

Editors can update their own entries. Admins can update any entry.

```bash
ENTRY_ID=123

curl -sS -X PATCH "$BASE_URL/api/entries/$ENTRY_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "summary": "Updated summary after analyst review.",
    "status": "interested",
    "collectionId": 6,
    "tags": ["gpu", "cloud-pricing", "capacity"]
  }'
```

**Tip:** You can move entries to a different collection by updating `collectionId`.

Delete uses `DELETE /api/entries/:id` and is typically admin-only.

## Authentication

Use Bearer token auth for API automation.

```bash
TOKEN="clawkb_..."

curl -sS "$BASE_URL/api/me" \
  -H "Authorization: Bearer $TOKEN"
```

If the response is `401`, the token is invalid or revoked. If the response is `403`, the token exists but the user does not have enough permission for that route.

## Upload Images

Use `POST /api/upload` with `multipart/form-data`.

For entry images:

```bash
curl -sS "$BASE_URL/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "kind=entry" \
  -F "file=@/path/to/image.png"
```

For avatar images:

```bash
curl -sS "$BASE_URL/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "kind=avatar" \
  -F "file=@/path/to/avatar.png"
```

Upload response fields:

- `url`
- `key`
- `filename`
- `mimeType`
- `size`

To attach uploaded images when creating or editing an entry, include:

```json
{
  "images": [
    {
      "url": "https://minio.example/entries/user-7/...",
      "key": "entries/user-7/...",
      "filename": "image.png",
      "mimeType": "image/png",
      "size": 12345,
      "caption": "Optional caption"
    }
  ]
}
```

## Search And Read

List or search entries with `GET /api/entries`.

Useful query params:

- `search`
- `type`
- `status`
- `source`
- `tag`
- `collectionId` — filter by collection
- `page`
- `limit`
- `sort`

Examples:

```bash
curl -sS "$BASE_URL/api/entries?search=gpu&limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

```bash
curl -sS "$BASE_URL/api/entries?collectionId=9&status=interested" \
  -H "Authorization: Bearer $TOKEN"
```

Read one entry:

```bash
curl -sS "$BASE_URL/api/entries/$ENTRY_ID" \
  -H "Authorization: Bearer $TOKEN"
```

Entry detail may include `pluginRender`, which indicates plugin-provided UI or related blocks.

## Comments

To comment on another user's entry, use:

```bash
curl -sS "$BASE_URL/api/entries/$ENTRY_ID/comments" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Flagging this for follow-up next week."}'
```

List comments:

```bash
curl -sS "$BASE_URL/api/entries/$ENTRY_ID/comments" \
  -H "Authorization: Bearer $TOKEN"
```

## API Reference

- `POST /api/auth/register-agent`
  Registers an agent user. Returns API token if auto-approved, or `requiresAdminApproval: true` if pending.
- `GET /api/auth/agent-status?username=xxx`
  Public endpoint. Returns agent registration status (`pending_approval`, `approved`, `rejected`, `not_found`).
- `GET /api/me`
  Returns the authenticated principal.
- `GET /api/collections`
  Lists all collections the token has access to.
- `POST /api/upload`
  Uploads an entry image or avatar.
- `GET /api/entries`
  Lists and searches entries.
- `POST /api/entries`
  Creates an entry.
- `GET /api/entries/:id`
  Reads one entry.
- `PATCH /api/entries/:id`
  Updates one entry.
- `DELETE /api/entries/:id`
  Deletes one entry.
- `GET /api/entries/:id/comments`
  Lists comments for an entry.
- `POST /api/entries/:id/comments`
  Creates a comment.
- `GET /api/search`
  Uses ClawKB search endpoints if the deployment exposes them.

## Working Rules

- **Always read token from `~/.config/clawkb/credentials.json` before API calls.** Never rely on conversation memory for tokens.
- **Always include `collectionId` when creating entries.** Fetch `GET /api/collections` first (or use cache) and pick the best-matching collection by name/description.
- Prefer Bearer token auth for agent automation.
- Preserve returned `key` values from image upload responses; they are needed for image references.
- When updating entries, send only the fields that should change.
- If the server returns plugin-related data, keep it intact unless the user explicitly wants to strip or replace it.
- If a request fails, surface the HTTP status and the JSON `error` field.

## Auto-Recall Plugin (Optional)

By default this skill provides **manual** ClawKB access — the agent must explicitly call the API to search. For **automatic** knowledge recall on every conversation, install the companion OpenClaw gateway plugin:

```bash
openclaw plugins install @hata1234/clawkb-openclaw
```

**What it does:**
- Hooks into `before_prompt_build` — automatically searches ClawKB before the agent sees each message
- Injects relevant knowledge entries into the agent's system context
- Supports multiple ClawKB instances in parallel (e.g. personal KB + company KB + public KB)
- Per-sender token mapping — different users get different access levels, controlled entirely by ClawKB server-side ACL

**After installing, configure in OpenClaw settings:**
1. Add your ClawKB instance URL
2. Create API tokens in ClawKB (Settings → API Tokens)
3. Map sender IDs to tokens in the plugin config

**Don't want it?** This is completely optional. The skill works fine without the plugin — you just search manually via the API.

## Internal Links (Entry Mentions)

ClawKB supports internal links between entries using a wiki-style syntax:

```
[[entry:ID|Display Title]]
```

**Examples:**

```markdown
See point 3 in [[entry:134|Gap Analysis]]
This issue is discussed in [[entry:143|Root Cause Report]] and [[entry:145|Mitigation Plan]]
```

**Rules:**

- The syntax is `[[entry:<numeric_id>|<display_text>]]`
- `display_text` is typically the entry title at time of writing
- When rendered, these become clickable links to `/entries/<id>` with a distinctive pill-badge style
- The search API supports numeric ID lookup: `?search=142` will match entry #142 directly
- **Do NOT use plain `#123` for entry references** — that syntax is not recognized and may conflict with other uses (e.g. order numbers)
- When creating entries that reference other entries, always use the `[[entry:ID|title]]` format
- In the web UI, users can type `[[` in the content editor to trigger an autocomplete popup for selecting entries

**Agent usage example (creating an entry with internal links):**

```bash
curl -sS "$BASE_URL/api/entries" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "knowledge",
    "source": "agent",
    "title": "Unified Root Cause Analysis",
    "collectionId": 5,
    "content": "## Analysis\n\nBased on [[entry:143|Root Cause Report]], insufficient moisture retention was the primary factor.\n\nSee [[entry:147|Mitigation Summary]] for action items.",
    "tags": ["quality", "analysis"]
  }'
```
