/**
 * clawkb-openclaw — Multi-instance ClawKB Auto-Recall Plugin for OpenClaw
 *
 * Queries one or more ClawKB servers in parallel on every (or filtered) user message,
 * then injects the most relevant knowledge chunks into the agent's system context.
 *
 * Key design principles:
 *  - NO client-side ACL: access is controlled entirely by which API token is used.
 *    Each sender maps to a token; the ClawKB server filters results based on that
 *    token's bound user/group/collection permissions.
 *  - Multi-instance: all configured instances are queried in parallel and results
 *    are merged, deduplicated, and sorted by similarity.
 *  - Graceful degradation: a failure on one instance never blocks results from others.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: number;
  title: string;
  summary: string;
  content: string;
  tags: { name: string }[];
  collections?: { id: number; name: string }[];
  similarity?: number;
  score?: number;
  snippet?: string;
}

/** A search result enriched with the instance it came from. */
interface AnnotatedResult extends SearchResult {
  _instanceId: string;
  _instanceLabel: string;
  _normalizedSimilarity: number; // Always 0–100 range
}

interface InstanceConfig {
  id: string;
  label?: string;
  url: string;
  /** API token for senders not in senderTokenMap. Null = require explicit mapping. */
  defaultToken?: string | null;
  /** sender_id → API token */
  senderTokenMap?: Record<string, string>;
}

interface PluginConfig {
  instances?: InstanceConfig[];
  enabled?: boolean;
  trigger?: 'always' | 'question' | 'keyword';
  keywords?: string[];
  topK?: number;
  threshold?: number;
  timeoutMs?: number;
  inject?: 'summary' | 'content' | 'full';
  maxTokens?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-level state
// ──────────────────────────────────────────────────────────────────────────────

/** Stats from the most recent successful search (for /clawkb status). */
let lastSearchStats: {
  query: string;
  instancesQueried: number;
  resultCount: number;
  timestamp: number;
} | null = null;

/** Regex to detect interrogative messages for trigger=question mode. */
const INTERROGATIVE_PATTERNS =
  /^(what|how|why|when|where|who|which|is|are|do|does|did|can|could|should|would|will|shall|have|has|had|是什麼|怎麼|為什麼|哪|什麼時候|如何)/i;

// ──────────────────────────────────────────────────────────────────────────────
// Config helpers
// ──────────────────────────────────────────────────────────────────────────────

function getConfig(api: any): PluginConfig {
  return api.config?.plugins?.entries?.['clawkb-openclaw']?.config ?? {};
}

// ──────────────────────────────────────────────────────────────────────────────
// Sender ID extraction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract the sender's unique ID from raw OpenClaw message text.
 *
 * OpenClaw prepends structured metadata to user messages in the format:
 *
 *   Conversation info (untrusted metadata):
 *   ```json
 *   { "sender_id": "...", ... }
 *   ```
 *
 *   Sender (untrusted metadata):
 *   ```json
 *   { "id": "...", "username": "...", ... }
 *   ```
 *
 *   <actual user message>
 *
 * Supports Telegram (numeric IDs), Discord (snowflake IDs), LINE, WhatsApp, etc.
 */
function extractSenderId(raw: string): string | null {
  // 1) Try the Sender block first (most reliable across all platforms)
  const senderMatch = raw.match(
    /Sender\s*\(untrusted metadata\):\s*```json\s*(\{[\s\S]*?\})\s*```/,
  );
  if (senderMatch) {
    try {
      const parsed = JSON.parse(senderMatch[1]);
      // id is the canonical sender identifier across platforms
      const id = parsed.id ?? parsed.sender_id ?? parsed.userId ?? parsed.user_id ?? null;
      if (id != null) return String(id);
    } catch {
      // Malformed JSON — fall through to next strategy
    }
  }

  // 2) Try the Conversation info block (some platforms only provide sender_id here)
  const convMatch = raw.match(
    /Conversation info\s*\(untrusted metadata\):\s*```json\s*(\{[\s\S]*?\})\s*```/,
  );
  if (convMatch) {
    try {
      const parsed = JSON.parse(convMatch[1]);
      const id = parsed.sender_id ?? parsed.user_id ?? parsed.userId ?? null;
      if (id != null) return String(id);
    } catch {
      // Malformed JSON — fall through
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// User text extraction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Strip OpenClaw metadata headers from a raw message and return the actual
 * user-authored text.
 *
 * The metadata section always ends with the last ``` block; everything after
 * that is the real message.
 */
function extractUserText(raw: string): string {
  // Strategy: find all ``` fence boundaries and take everything after the last one
  const parts = raw.split('```');

  if (parts.length >= 5) {
    // At least 2 complete code blocks (conversation info + sender blocks)
    const afterMeta = parts.slice(4).join('```').trim();
    if (afterMeta) return afterMeta;
  }

  // Fallback: everything after the final closing ```
  const lastFence = raw.lastIndexOf('```');
  if (lastFence > 0) {
    const after = raw.slice(lastFence + 3).trim();
    if (after) return after;
  }

  // No metadata detected — return raw message as-is
  return raw.trim();
}

/**
 * Walk backwards through the messages array to find the most recent user message.
 * Handles string content, array of content parts, and object content.
 */
function getLastUserMessage(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !msg.content) continue;

    if (typeof msg.content === 'string') return msg.content;

    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((p: any) => p.type === 'text' && p.text)
        .map((p: any) => p.text)
        .join(' ');
      if (text) return text;
    }

    if (typeof msg.content === 'object' && msg.content.text) {
      return msg.content.text;
    }

    const str = String(msg.content);
    if (str && str !== '[object Object]') return str;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Search trigger logic
// ──────────────────────────────────────────────────────────────────────────────

function shouldSearch(text: string, config: PluginConfig): boolean {
  const trigger = config.trigger ?? 'always';

  if (trigger === 'always') return true;

  if (trigger === 'question') {
    if (text.includes('?') || text.includes('？')) return true;
    return INTERROGATIVE_PATTERNS.test(text.trim());
  }

  if (trigger === 'keyword') {
    const keywords = config.keywords ?? [];
    if (keywords.length === 0) return false;
    const lower = text.toLowerCase();
    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Token resolution (the ACL layer — purely token-based, no client filtering)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve which API token to use for a given sender on a given instance.
 *
 * Priority:
 *   1. senderTokenMap[senderId]  — explicit per-sender token
 *   2. defaultToken              — catch-all for public KBs
 *   3. null                      — skip this instance
 *
 * The resolved token is sent as the Bearer token; the ClawKB server uses it to
 * determine what the caller can see. There is no client-side filtering here.
 */
function resolveToken(
  senderId: string | null,
  instance: InstanceConfig,
): string | null {
  // Check explicit sender mapping first
  if (senderId && instance.senderTokenMap) {
    const token = instance.senderTokenMap[senderId];
    if (token) return token;
  }

  // Fall back to default token (public KB or catch-all)
  if (instance.defaultToken) return instance.defaultToken;

  // No token available — skip this instance for this sender
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// ClawKB API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Execute a semantic search against a single ClawKB instance.
 * Returns raw results from the server (unfiltered by similarity threshold).
 */
async function searchInstance(
  query: string,
  instance: InstanceConfig,
  token: string,
  topK: number,
  timeoutMs: number,
): Promise<AnnotatedResult[]> {
  const baseUrl = instance.url.replace(/\/+$/, '');
  const searchUrl = `${baseUrl}/api/search`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, limit: topK }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const data: any = await resp.json();
    const raw: SearchResult[] = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data)
      ? data
      : [];

    // Annotate each result with its source instance
    return raw.map((r) => ({
      ...r,
      _instanceId: instance.id,
      _instanceLabel: instance.label ?? instance.id,
      // ClawKB returns similarity as 0–100; normalize for consistent threshold comparisons
      _normalizedSimilarity: r.similarity ?? r.score ?? 0,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query all instances in parallel for a given sender.
 * Instances where the sender has no token are silently skipped.
 * Individual failures are caught and logged; they don't affect other instances.
 */
async function searchAllInstances(
  query: string,
  senderId: string | null,
  config: PluginConfig,
  api: any,
): Promise<AnnotatedResult[]> {
  const instances = config.instances ?? [];
  const topK = config.topK ?? 5;
  const timeoutMs = config.timeoutMs ?? 500;

  // Build the list of [instance, token] pairs to query
  const tasks: Array<{ instance: InstanceConfig; token: string }> = [];
  for (const inst of instances) {
    const token = resolveToken(senderId, inst);
    if (!token) {
      api.logger?.debug?.(
        `ClawKB: skipping instance "${inst.id}" — no token for sender ${senderId ?? 'unknown'}`,
      );
      continue;
    }
    tasks.push({ instance: inst, token });
  }

  if (tasks.length === 0) return [];

  // Fire all queries in parallel
  const settled = await Promise.allSettled(
    tasks.map(({ instance, token }) =>
      searchInstance(query, instance, token, topK, timeoutMs),
    ),
  );

  const allResults: AnnotatedResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const inst = tasks[i].instance;
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
      api.logger?.debug?.(
        `ClawKB: instance "${inst.id}" returned ${result.value.length} results`,
      );
    } else {
      const err = result.reason;
      if (err?.name === 'AbortError') {
        api.logger?.debug?.(`ClawKB: instance "${inst.id}" timed out`);
      } else {
        api.logger?.warn?.(
          `ClawKB: instance "${inst.id}" error: ${err?.message ?? err}`,
        );
      }
    }
  }

  return allResults;
}

// ──────────────────────────────────────────────────────────────────────────────
// Post-processing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Apply similarity threshold and sort merged results.
 * Threshold config is 0–1; ClawKB scores are 0–100, so multiply threshold by 100.
 */
function applyThresholdAndSort(
  results: AnnotatedResult[],
  threshold: number,
): AnnotatedResult[] {
  const minScore = threshold * 100;
  return results
    .filter((r) => r._normalizedSimilarity >= minScore)
    .sort((a, b) => b._normalizedSimilarity - a._normalizedSimilarity);
}

// ──────────────────────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────────────────────

function truncateToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

/**
 * Format annotated results for injection into the system context.
 * Each result is prefixed with its source label: [home#23] or [openclaw-public#7]
 */
function formatResults(results: AnnotatedResult[], config: PluginConfig): string {
  const mode = config.inject ?? 'summary';
  const maxChars = (config.maxTokens ?? 800) * 4; // ~4 chars per token
  const lines: string[] = [];

  lines.push('--- ClawKB Knowledge (auto-recalled) ---');

  for (const r of results) {
    const label = `[${r._instanceLabel}#${r.id}]`;

    if (mode === 'summary') {
      lines.push(`${label} ${r.title} — ${r.summary}`);
    } else if (mode === 'content') {
      lines.push(`## ${label} ${r.title}`);
      lines.push(r.summary);
      if (r.content) {
        lines.push('');
        lines.push(r.content);
      }
      lines.push('');
    } else {
      // full
      lines.push(`## ${label} ${r.title}`);
      lines.push(r.summary);
      const body = r.content || r.snippet || '';
      if (body) {
        lines.push('');
        lines.push(body);
      }
      if (r.tags && r.tags.length > 0) {
        lines.push(`Tags: ${r.tags.map((t) => t.name).join(', ')}`);
      }
      if (r.collections && r.collections.length > 0) {
        lines.push(`Collections: ${r.collections.map((c) => c.name).join(', ')}`);
      }
      lines.push(`Similarity: ${r._normalizedSimilarity.toFixed(1)}`);
      lines.push('');
    }
  }

  lines.push('---');

  return truncateToMaxChars(lines.join('\n'), maxChars);
}

// ──────────────────────────────────────────────────────────────────────────────
// Status formatting
// ──────────────────────────────────────────────────────────────────────────────

function formatStatusText(config: PluginConfig): string {
  const instances = config.instances ?? [];
  const lines: string[] = [
    '**ClawKB Multi-Instance Auto-Recall**',
    '',
    `- Enabled: ${config.enabled !== false}`,
    `- Trigger: ${config.trigger ?? 'always'}`,
    `- Top K per instance: ${config.topK ?? 5}`,
    `- Threshold: ${config.threshold ?? 0.3}`,
    `- Timeout: ${config.timeoutMs ?? 500}ms`,
    `- Inject mode: ${config.inject ?? 'summary'}`,
    `- Max tokens: ${config.maxTokens ?? 800}`,
  ];

  if (config.trigger === 'keyword') {
    lines.push(`- Keywords: ${(config.keywords ?? []).join(', ') || '(none)'}`);
  }

  lines.push('');
  lines.push(`**Instances (${instances.length})**`);

  if (instances.length === 0) {
    lines.push('_No instances configured._');
  } else {
    for (const inst of instances) {
      const senderCount = Object.keys(inst.senderTokenMap ?? {}).length;
      const hasDefault = !!inst.defaultToken;
      lines.push(
        `- **${inst.label ?? inst.id}** (\`${inst.id}\`) → ${inst.url}`,
      );
      lines.push(
        `  Senders mapped: ${senderCount} | Default token: ${hasDefault ? 'yes' : 'no'}`,
      );
    }
  }

  if (lastSearchStats) {
    lines.push('');
    lines.push('**Last Search**');
    lines.push(`- Query: ${lastSearchStats.query}`);
    lines.push(`- Instances queried: ${lastSearchStats.instancesQueried}`);
    lines.push(`- Results injected: ${lastSearchStats.resultCount}`);
    lines.push(
      `- Time: ${new Date(lastSearchStats.timestamp).toLocaleString()}`,
    );
  } else {
    lines.push('');
    lines.push('_No searches performed yet this session._');
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Plugin entry point
// ──────────────────────────────────────────────────────────────────────────────

export default function register(api: any) {
  api.logger?.info?.('ClawKB Multi-Instance Auto-Recall plugin registered');

  // ── Hook: inject knowledge before each prompt build ──────────────────────

  api.on(
    'before_prompt_build',
    async (event: { messages: any[] }, _ctx: any) => {
      api.logger?.debug?.('ClawKB: before_prompt_build hook triggered');

      const config = getConfig(api);

      // Master switch
      if (config.enabled === false) return {};

      // Need at least one instance
      const instances = config.instances ?? [];
      if (instances.length === 0) return {};

      // Get the raw user message (may contain OpenClaw metadata headers)
      const prompt = (event as any).prompt;
      const rawMessage =
        typeof prompt === 'string' ? prompt : getLastUserMessage(event.messages);
      if (!rawMessage) return {};

      // Extract sender ID from metadata (used for token resolution)
      const senderId = extractSenderId(rawMessage);
      api.logger?.debug?.(`ClawKB: sender_id = ${senderId ?? 'unknown'}`);

      // Strip metadata to get the actual user query
      const userText = extractUserText(rawMessage);

      // Check trigger conditions
      if (!shouldSearch(userText, config)) return {};

      // Query all instances in parallel
      const allResults = await searchAllInstances(userText, senderId, config, api);

      // Apply threshold and sort
      const threshold = config.threshold ?? 0.3;
      const filtered = applyThresholdAndSort(allResults, threshold);

      api.logger?.info?.(
        `ClawKB: ${filtered.length}/${allResults.length} results above threshold (${threshold})`,
      );

      // Update stats
      lastSearchStats = {
        query: userText.slice(0, 100),
        instancesQueried: instances.filter((inst) => resolveToken(senderId, inst) !== null).length,
        resultCount: filtered.length,
        timestamp: Date.now(),
      };

      if (filtered.length === 0) return {};

      const formatted = formatResults(filtered, config);
      return { appendSystemContext: formatted };
    },
    { priority: 10 },
  );

  // ── Command: /clawkb ─────────────────────────────────────────────────────

  api.registerCommand({
    name: 'clawkb',
    description: 'ClawKB multi-instance status and query testing',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: { args?: string; senderId?: string }) => {
      const config = getConfig(api);
      const args = (ctx.args ?? '').trim();

      // /clawkb  or  /clawkb status
      if (!args || args === 'status') {
        return { text: formatStatusText(config) };
      }

      // /clawkb test <query>
      if (args.startsWith('test ')) {
        const query = args.slice(5).trim();
        if (!query) {
          return { text: 'Usage: /clawkb test <query>' };
        }

        const instances = config.instances ?? [];
        if (instances.length === 0) {
          return { text: 'Error: no ClawKB instances configured.' };
        }

        // Use the command caller's sender ID for token resolution
        const senderId = ctx.senderId ?? null;

        try {
          const allResults = await searchAllInstances(query, senderId, config, api);
          const threshold = config.threshold ?? 0.3;
          const filtered = applyThresholdAndSort(allResults, threshold);

          if (filtered.length === 0) {
            return {
              text: `No results above threshold (${threshold}) for: "${query}"\n(${allResults.length} raw results discarded)`,
            };
          }

          const formatted = formatResults(filtered, config);
          return {
            text:
              `**Test Search** — ${filtered.length}/${allResults.length} results above threshold ${threshold}\n\n` +
              formatted,
          };
        } catch (err: any) {
          return { text: `Search error: ${err.message}` };
        }
      }

      // /clawkb instances
      if (args === 'instances') {
        const instances = config.instances ?? [];
        if (instances.length === 0) {
          return { text: 'No instances configured.' };
        }
        const lines = instances.map((inst) => {
          const senderCount = Object.keys(inst.senderTokenMap ?? {}).length;
          return `**${inst.label ?? inst.id}** — ${inst.url}\n  Senders: ${senderCount} | Default token: ${inst.defaultToken ? 'yes' : 'no'}`;
        });
        return { text: lines.join('\n\n') };
      }

      return {
        text: 'Usage:\n  /clawkb status\n  /clawkb test <query>\n  /clawkb instances',
      };
    },
  });
}
