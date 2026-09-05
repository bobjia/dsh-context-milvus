/**
 * Query expansion for code search.
 *
 * Expands natural language queries with code-relevant synonyms and
 * technical terms before embedding, improving recall and hit@1 for
 * queries that use different vocabulary than the code (e.g., "retry
 * with exponential backoff" → "retry backoff delay retry-strategy").
 *
 * The expansion appends to the original query rather than replacing it,
 * so the embedding model receives both the natural language signal and
 * the code-flavored signal.
 */

/**
 * Code synonym dictionary: natural language or general terms → code terms.
 * Each entry adds code-relevant vocabulary for the embedding.
 */
const CODE_SYNONYMS: Record<string, string[]> = {
  // ── Authentication & Security ──
  login: ['login', 'authenticate', 'signin', 'auth'],
  authentication: ['authentication', 'login', 'auth', 'token', 'credential'],
  logout: ['logout', 'signout', 'revoke', 'session'],
  password: ['password', 'credential', 'secret', 'hash'],
  token: ['token', 'jwt', 'access-token', 'auth', 'session'],
  permission: ['permission', 'role', 'acl', 'authorization', 'auth'],

  // ── Database & Storage ──
  database: ['database', 'db', 'sql', 'query', 'persist'],
  query: ['query', 'select', 'sql', 'find', 'search'],
  migration: ['migration', 'migrate', 'schema', 'ddl'],
  cache: ['cache', 'caching', 'redis', 'memcached', 'ttl'],
  'sql query': ['sql', 'query', 'select', 'statement', 'parameterized'],

  // ── Data Processing ──
  parse: ['parse', 'parser', 'tokenize', 'decode'],
  json: ['json', 'serialize', 'deserialize', 'parse'],
  merge: ['merge', 'combine', 'concat', 'deep-merge'],
  sort: ['sort', 'sorting', 'order', 'compare'],
  transform: ['transform', 'convert', 'map', 'process'],

  // ── Error Handling ──
  error: ['error', 'exception', 'throw', 'catch', 'err'],
  retry: ['retry', 'retrying', 'backoff', 'retry-strategy', 'timeout'],
  backoff: ['backoff', 'retry', 'retry-delay', 'exponential'],
  exception: ['exception', 'error', 'throw', 'try-catch'],

  // ── Network & HTTP ──
  http: ['http', 'request', 'response', 'rest', 'api', 'endpoint'],
  request: ['request', 'http', 'rest', 'api', 'endpoint'],
  middleware: ['middleware', 'interceptor', 'filter', 'handler'],
  send: ['send', 'post', 'dispatch', 'emit'],
  connect: ['connect', 'connection', 'socket', 'tcp'],
  email: ['email', 'mail', 'smtp', 'message'],
  'send email': ['email', 'mail', 'smtp', 'send-mail'],

  // ── Async & Concurrency ──
  async: ['async', 'await', 'promise', 'future', 'completable'],
  worker: ['worker', 'job', 'task', 'background', 'thread'],
  queue: ['queue', 'queuing', 'task-queue', 'message-queue', 'job'],

  // ── Config & Environment ──
  config: ['config', 'configuration', 'settings', 'env', 'properties'],
  environment: ['environment', 'env', 'config', 'variable'],

  // ── ML & Vector ──
  embedding: ['embedding', 'vector', 'embed', 'encode'],
  similarity: ['similarity', 'cosine', 'distance', 'vector'],
  search: ['search', 'retrieval', 'query', 'find', 'lookup'],

  // ── Logging & Monitoring ──
  logging: ['logging', 'log', 'logger', 'monitor'],
  metric: ['metric', 'metrics', 'counter', 'gauge', 'statistics'],

  // ── General ──
  validation: ['validation', 'validate', 'check', 'verify', 'assert'],
  format: ['format', 'formatting', 'stringify', 'tostring'],
  helper: ['helper', 'util', 'utility', 'utils', 'tool'],
  factory: ['factory', 'create', 'builder', 'constructor'],
  init: ['init', 'initialize', 'setup', 'bootstrap'],
}

/** Max expanded query length to avoid exceeding embedding model context */
const MAX_EXPANDED_LENGTH = 512

/**
 * Normalize a word: lowercase, strip trailing punctuation.
 */
function normalize(w: string): string {
  return w.toLowerCase().replace(/[.,!?;:']+$/, '')
}

/**
 * Expand a user query with code-relevant terms.
 *
 * Strategy:
 * 1. Keep the original query as-is (preserves the natural language signal).
 * 2. For each word (or known multi-word phrase), append its code synonyms.
 * 3. Deduplicate and cap the total length.
 *
 * @param query - The raw user query
 * @returns Expanded query string suitable for embedding
 */
export function expandQuery(query: string): string {
  if (!query || query.trim().length === 0) return query.trim()

  const trimmed = query.trim()
  const words = trimmed.split(/\s+/)
  const expansions: string[] = []

  // Try to match multi-word phrases first (longest match)
  const sortedPhrases = Object.keys(CODE_SYNONYMS).sort((a, b) => b.length - a.length)

  for (let i = 0; i < words.length; i++) {
    // Try multi-word match starting at position i
    let matched = false
    for (const phrase of sortedPhrases) {
      const phraseWords = phrase.split(/\s+/)
      if (i + phraseWords.length <= words.length) {
        const slice = words.slice(i, i + phraseWords.length).join(' ')
        if (normalize(slice) === phrase) {
          expansions.push(...CODE_SYNONYMS[phrase])
          i += phraseWords.length - 1
          matched = true
          break
        }
      }
    }
    if (!matched) {
      const norm = normalize(words[i])
      if (CODE_SYNONYMS[norm]) {
        expansions.push(...CODE_SYNONYMS[norm])
      }
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const uniqueExpansions: string[] = []
  for (const term of expansions) {
    const key = term.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      uniqueExpansions.push(term)
    }
  }

  // Append expansions to the original query (separated by " — " to hint
  // to the embedding model that these are different aspects)
  let expanded = trimmed
  if (uniqueExpansions.length > 0) {
    expanded += ' — ' + uniqueExpansions.join(' ')
  }

  // Cap total length
  if (expanded.length > MAX_EXPANDED_LENGTH) {
    expanded = expanded.slice(0, MAX_EXPANDED_LENGTH).trimEnd()
  }

  return expanded
}