# clawkb-openclaw

**Multi-instance ClawKB Auto-Recall plugin for OpenClaw**

Automatically searches one or more [ClawKB](https://github.com/hata1234/clawkb) knowledge base servers on every user message, then injects the most relevant results into the agent's system context — giving your AI assistant instant recall of your personal/team knowledge without any manual retrieval step.

---

## Key Features

- **Multi-instance** — connect to any number of ClawKB servers simultaneously
- **Per-sender token mapping** — each user (Telegram, Discord, LINE, WhatsApp…) maps to their own API token with server-side permission control
- **Default token** — public knowledge bases can be queried by anyone without explicit mapping
- **Server-side ACL only** — no client-side filtering; what a user can see is determined entirely by the API token and ClawKB server permissions
- **Parallel queries** — all instances are queried concurrently; one failure never blocks the others
- **Configurable triggers** — search always, only on questions, or only when specific keywords appear
- **Graceful degradation** — timeouts and errors per instance are logged and skipped silently

---

## Installation

Copy or symlink this directory into your OpenClaw extensions folder:

```bash
# Option A: symlink (recommended for development)
ln -s /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw

# Option B: copy
cp -r /path/to/clawkb-openclaw ~/.openclaw/extensions/clawkb-openclaw
```

Then reload OpenClaw (or restart the gateway).

---

## Configuration

Add to your OpenClaw `config.json` under `plugins.entries`:

```json
{
  "clawkb-openclaw": {
    "config": {
      "instances": [
        {
          "id": "home",
          "label": "Home KB",
          "url": "http://localhost:3500",
          "defaultToken": null,
          "senderTokenMap": {
            "123456789": "clawkb_tok_alice_full",
            "987654321": "clawkb_tok_bob_readonly"
          }
        },
        {
          "id": "openclaw-public",
          "label": "OpenClaw Public KB",
          "url": "https://kb.openclaw.ai",
          "defaultToken": "clawkb_tok_public",
          "senderTokenMap": {}
        }
      ],
      "trigger": "always",
      "topK": 5,
      "threshold": 0.3,
      "timeoutMs": 500,
      "inject": "summary",
      "maxTokens": 800
    }
  }
}
```

### Instance Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | ✅ | Unique identifier, used in result labels (`[home#23]`) |
| `label` | string | — | Human-readable label shown in injected text |
| `url` | string | ✅ | ClawKB base URL |
| `defaultToken` | string \| null | — | Token for senders not in `senderTokenMap`. Set for public KBs. |
| `senderTokenMap` | object | — | Maps sender ID → API token |

### Plugin-level Options

| Option | Default | Description |
|--------|---------|-------------|
| `trigger` | `"always"` | `always` \| `question` \| `keyword` |
| `keywords` | `[]` | Keywords to match (only when `trigger="keyword"`) |
| `topK` | `5` | Max results to fetch per instance |
| `threshold` | `0.3` | Min similarity score (0–1) to inject a result |
| `timeoutMs` | `500` | Per-instance request timeout |
| `inject` | `"summary"` | `summary` \| `content` \| `full` |
| `maxTokens` | `800` | Max approximate tokens to inject |

---

## How It Works

1. **`before_prompt_build` hook** fires before every prompt is sent to the LLM
2. The sender's ID is extracted from OpenClaw metadata headers (supports Telegram, Discord, LINE, WhatsApp)
3. For each instance, the plugin resolves which API token to use:
   - `senderTokenMap[senderId]` → use that token
   - No match + `defaultToken` set → use default token
   - Neither → skip this instance
4. All eligible instances are queried **in parallel** via `POST /api/search`
5. Results are merged, threshold-filtered, and sorted by similarity (descending)
6. Formatted results are injected as `appendSystemContext`

### Injected Format

```
--- ClawKB Knowledge (auto-recalled) ---
[Home KB#23] Product FAQ — Our desiccant packets absorb up to 30% moisture…
[Home KB#41] Pricing Sheet — B2B bulk pricing starts at NT$0.8/unit…
[OpenClaw Public KB#7] Quick Start Guide — Install OpenClaw with brew…
---
```

---

## Commands

### `/clawkb status`
Shows plugin configuration, instance list, and last search stats.

### `/clawkb test <query>`
Runs a test search against all configured instances using your sender token, and displays the formatted results.

### `/clawkb instances`
Lists all configured instances with sender count and default token status.

---

## Access Control

**All ACL is handled server-side by ClawKB.** The plugin does not filter results — it simply passes the correct API token, and the server returns only what that token is permitted to see (based on bound user, group, and collection permissions configured in ClawKB).

To give a user access to a knowledge base:
1. Create an API token in ClawKB with the appropriate permissions
2. Add the user's sender ID → token mapping to `senderTokenMap`

To revoke access: remove the mapping or invalidate the token in ClawKB.

---

## Supported Platforms

Sender ID extraction is tested with:
- **Telegram** — numeric user ID
- **Discord** — snowflake ID
- **LINE** — LINE user ID string
- **WhatsApp** — phone number

---

## License

AGPL-3.0 — see [LICENSE](LICENSE)
