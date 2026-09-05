import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadDataset } from './lib/dataset.mjs'
import { grepBaseline, naiveRagBaseline } from './lib/baselines.mjs'
import { recallAtK, mrr, ndcgAtK, hitAtK, precisionAtK } from './lib/metrics.mjs'
import { wilcoxonSignedRank, bootstrapMeanDiffCi, cliffsDelta, mulberry32 } from './lib/stats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', '..', '..', 'dist', 'plugins', 'dsh-context-milvus')

const { runIndex } = await import(path.join(distDir, 'indexer.js'))
const { MilvusService } = await import(path.join(distDir, 'milvus-service.js'))
const { HashTracker } = await import(path.join(distDir, 'merkle.js'))
const { getConfig } = await import(path.join(distDir, 'config.js'))
const { EmbeddingClient } = await import(path.join(distDir, 'embedding.js'))

const TOPK = 10
const COLLECTION = 'eval_retrieval_' + Date.now()

// 1. 临时测试仓库（与 sample-dataset.json 的查询对齐）
const tempDir = await mkdtemp(path.join(tmpdir(), 'retrieval-eval-'))
const files = {
  // ── TypeScript ──
  'src/greeter.ts': `export class Greeter {\n  private name: string\n  constructor(name: string) { this.name = name }\n  greet(): string { return \`Hello, \${this.name}!\` }\n}\n`,
  'src/math.ts': `export function add(a: number, b: number): number { return a + b }\nexport function multiply(a: number, b: number): number { return a * b }\n`,
  'src/auth/login.ts': `export async function loginUser(email: string, password: string): Promise<string> {\n  const user = await db.users.findOne({ email })\n  if (!user) throw new AuthError('User not found')\n  const valid = await bcrypt.compare(password, user.passwordHash)\n  if (!valid) throw new AuthError('Invalid password')\n  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' })\n  return token\n}\n`,
  'src/auth/session.ts': `export class SessionManager {\n  private store: Map<string, Session> = new Map()\n  async create(userId: string): Promise<Session> {\n    const session = { id: crypto.randomUUID(), userId, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600000) }\n    this.store.set(session.id, session)\n    return session\n  }\n  async get(sessionId: string): Promise<Session | null> {\n    const s = this.store.get(sessionId)\n    if (!s || s.expiresAt < new Date()) { this.store.delete(sessionId); return null }\n    return s\n  }\n  async revoke(sessionId: string): Promise<void> { this.store.delete(sessionId) }\n}\n`,
  'src/db/query.ts': `export class QueryBuilder {\n  private table: string; private conditions: string[] = []; private orderByClause = ''; private limitCount = 0\n  constructor(table: string) { this.table = table }\n  where(column: string, op: string, value: unknown): QueryBuilder {\n    this.conditions.push(\`\${column} \${op} \${typeof value === 'string' ? \"'\" + value + \"'\" : value}\`)\n    return this\n  }\n  orderBy(column: string, dir: 'ASC' | 'DESC' = 'ASC'): QueryBuilder {\n    this.orderByClause = \`ORDER BY \${column} \${dir}\`; return this\n  }\n  limit(n: number): QueryBuilder { this.limitCount = n; return this }\n  build(): string {\n    let sql = \`SELECT * FROM \${this.table}\`\n    if (this.conditions.length) sql += ' WHERE ' + this.conditions.join(' AND ')\n    if (this.orderByClause) sql += ' ' + this.orderByClause\n    if (this.limitCount) sql += \` LIMIT \${this.limitCount}\`\n    return sql\n  }\n}\n`,
  'src/db/migration.ts': `export class MigrationRunner {\n  private migrations: Migration[] = []\n  private executed = new Set<string>()\n  add(m: Migration): void { this.migrations.push(m) }\n  async runAll(): Promise<void> {\n    const sorted = [...this.migrations].sort((a, b) => a.version - b.version)\n    for (const m of sorted) {\n      if (this.executed.has(m.id)) continue\n      console.log(\`Running migration \${m.id} v\${m.version}\`)\n      await m.up()\n      this.executed.add(m.id)\n    }\n  }\n  async rollback(version: number): Promise<void> {\n    const m = this.migrations.find(m => m.version === version)\n    if (!m) throw new Error(\`Migration v\${version} not found\`)\n    await m.down()\n    this.executed.delete(m.id)\n  }\n}\n`,
  'src/error/errors.ts': `export class AppError extends Error {\n  constructor(message: string, public statusCode: number = 500) { super(message); this.name = 'AppError' }\n}\nexport class AuthError extends AppError {\n  constructor(message: string) { super(message, 401); this.name = 'AuthError' }\n}\nexport class NotFoundError extends AppError {\n  constructor(resource: string) { super(\`\${resource} not found\`, 404); this.name = 'NotFoundError' }\n}\nexport class ValidationError extends AppError {\n  constructor(public errors: string[]) { super('Validation failed', 422); this.name = 'ValidationError' }\n}\n`,
  'src/utils/retry.ts': `export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {\n  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000 } = options\n  let lastError: Error | null = null\n  for (let attempt = 0; attempt <= maxRetries; attempt++) {\n    try { return await fn() }\n    catch (err) {\n      lastError = err as Error\n      if (attempt === maxRetries) break\n      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)\n      await new Promise(r => setTimeout(r, delay + Math.random() * 1000))\n    }\n  }\n  throw lastError\n}\n`,
  'src/cache/redis.ts': `export class RedisCache {\n  private client: Redis; private defaultTtl: number\n  constructor(url: string, defaultTtl = 300) {\n    this.client = new Redis(url)\n    this.defaultTtl = defaultTtl\n  }\n  async get<T>(key: string): Promise<T | null> {\n    const raw = await this.client.get(key)\n    return raw ? JSON.parse(raw) : null\n  }\n  async set<T>(key: string, value: T, ttl?: number): Promise<void> {\n    await this.client.set(key, JSON.stringify(value), 'EX', ttl ?? this.defaultTtl)\n  }\n  async del(key: string): Promise<void> { await this.client.del(key) }\n  async clear(pattern: string): Promise<void> {\n    const keys = await this.client.keys(pattern)\n    if (keys.length) await this.client.del(...keys)\n  }\n}\n`,
  'src/worker/task.ts': `export interface Task<T = unknown> {\n  id: string; type: string; payload: T; priority: number; createdAt: Date\n}\nexport abstract class TaskWorker {\n  abstract execute(task: Task): Promise<void>\n  async handle(task: Task): Promise<void> {\n    try {\n      console.log(\`Processing task \${task.id} [\${task.type}]\`)\n      await this.execute(task)\n    } catch (err) {\n      console.error(\`Task \${task.id} failed: \`, err)\n      throw err\n    }\n  }\n}\n`,
  'src/worker/queue.ts': `export class TaskQueue {\n  private queue: Task[] = []; private processing = false; private workers: Map<string, TaskWorker> = new Map()\n  register(type: string, worker: TaskWorker): void { this.workers.set(type, worker) }\n  enqueue(task: Task): void {\n    this.queue.push(task)\n    this.queue.sort((a, b) => b.priority - a.priority)\n    this.processNext()\n  }\n  private async processNext(): Promise<void> {\n    if (this.processing || this.queue.length === 0) return\n    this.processing = true\n    const task = this.queue.shift()!\n    const worker = this.workers.get(task.type)\n    if (worker) { try { await worker.handle(task) } catch { /* logged in worker */ } }\n    this.processing = false\n    this.processNext()\n  }\n  get pending(): number { return this.queue.length }\n}\n`,

  // ── Python ──
  'src/utils.py': `def parse_json(text):\n    import json\n    return json.loads(text)\n\nclass DataProcessor:\n    def process(self, data):\n        return {k: v for k, v in data.items()}\n`,
  'src/ml/embed.py': `import numpy as np\nfrom sklearn.metrics.pairwise import cosine_similarity\n\ndef embed_text(text: str, model) -> np.ndarray:\n    return model.encode(text)\n\ndef search_similar(query_vec: np.ndarray, candidates: list[np.ndarray], top_k: int = 5) -> list[int]:\n    scores = cosine_similarity(query_vec.reshape(1, -1), np.array(candidates))[0]\n    indices = np.argsort(scores)[::-1][:top_k]\n    return [int(i) for i in indices]\n\nclass VectorIndex:\n    def __init__(self, dim: int):\n        self.dim = dim\n        self.vectors: list[np.ndarray] = []\n        self.keys: list[str] = []\n    def add(self, key: str, vec: np.ndarray):\n        self.vectors.append(vec)\n        self.keys.append(key)\n    def search(self, query: np.ndarray, top_k: int = 5) -> list[str]:\n        indices = search_similar(query, self.vectors, top_k)\n        return [self.keys[i] for i in indices]\n`,

  // ── Go ──
  'src/lib.rs': `pub struct Config { pub host: String, pub port: u16 }\nimpl Config {\n    pub fn new(host: &str, port: u16) -> Self { Self { host: host.to_string(), port } }\n    pub fn addr(&self) -> String { format!("{}:{}", self.host, self.port) }\n}\n`,
  'src/go/server.go': `package server\n\nimport (\n\t"encoding/json"\n\t"net/http"\n\t"time"\n)\n\ntype Middleware func(http.Handler) http.Handler\n\ntype Server struct {\n\taddr       string\n\thandler    http.Handler\n\tmiddleware []Middleware\n}\n\nfunc New(addr string) *Server {\n\treturn &Server{addr: addr, handler: http.NewServeMux()}\n}\n\nfunc (s *Server) Use(m Middleware) { s.middleware = append(s.middleware, m) }\n\nfunc (s *Server) Get(path string, h http.HandlerFunc) {\n\ts.HandleFunc("GET " + path, h)\n}\n\nfunc (s *Server) HandleFunc(pattern string, h http.HandlerFunc) {\n\ts.handler.(*http.ServeMux).HandleFunc(pattern, h)\n}\n\nfunc (s *Server) ListenAndServe() error {\n\tvar h http.Handler = s.handler\n\tfor i := len(s.middleware) - 1; i >= 0; i-- {\n\t\th = s.middleware[i](h)\n\t}\n\treturn http.ListenAndServe(s.addr, h)\n}\n\nfunc LoggerMiddleware(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tstart := time.Now()\n\t\tnext.ServeHTTP(w, r)\n\t\tlog.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))\n\t})\n}\n\nfunc JSON(h func(w http.ResponseWriter, r *http.Request) (interface{}, error)) http.HandlerFunc {\n\treturn func(w http.ResponseWriter, r *http.Request) {\n\t\tw.Header().Set("Content-Type", "application/json")\n\t\tresult, err := h(w, r)\n\t\tif err != nil { http.Error(w, err.Error(), 500); return }\n\t\tjson.NewEncoder(w).Encode(result)\n\t}\n}\n`,
  'src/go/database.go': `package database\n\nimport (\n\t"context"\n\t"fmt"\n\t"time"\n)\n\ntype DB struct {\n\tdsn             string\n\tmaxOpenConns    int\n\tmaxIdleConns    int\n\tconnMaxLifetime time.Duration\n}\n\nfunc NewDB(dsn string) *DB {\n\treturn &DB{dsn: dsn, maxOpenConns: 25, maxIdleConns: 5, connMaxLifetime: 5 * time.Minute}\n}\n\nfunc (db *DB) Query(ctx context.Context, sql string, args ...interface{}) ([]map[string]interface{}, error) {\n\tconn, err := db.getConn(ctx)\n\tif err != nil { return nil, fmt.Errorf("get conn: %w", err) }\n\tdefer db.releaseConn(conn)\n\trows, err := conn.QueryContext(ctx, sql, args...)\n\tif err != nil { return nil, fmt.Errorf("query: %w", err) }\n\tdefer rows.Close()\n\tvar results []map[string]interface{}\n\tfor rows.Next() {\n\t\trow := make(map[string]interface{})\n\t\tif err := rows.Scan(row); err != nil { return nil, err }\n\t\tresults = append(results, row)\n\t}\n\treturn results, nil\n}\n\nfunc (db *DB) Exec(ctx context.Context, sql string, args ...interface{}) (int64, error) {\n\tconn, err := db.getConn(ctx)\n\tif err != nil { return 0, err }\n\tdefer db.releaseConn(conn)\n\tresult, err := conn.ExecContext(ctx, sql, args...)\n\tif err != nil { return 0, fmt.Errorf("exec: %w", err) }\n\treturn result.RowsAffected()\n}\n\nfunc (db *DB) getConn(ctx context.Context) (interface{}, error) { return nil, nil }\nfunc (db *DB) releaseConn(conn interface{}) {}\n`,

  // ── Java ──
  'src/java/HttpClient.java': `package com.example.http;\n\nimport java.net.URI;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\nimport java.time.Duration;\nimport java.util.concurrent.CompletableFuture;\n\npublic class HttpClient {\n    private final java.net.http.HttpClient client;\n    private final String baseUrl;\n    private final Duration timeout;\n\n    public HttpClient(String baseUrl, Duration timeout) {\n        this.client = java.net.http.HttpClient.newBuilder()\n            .connectTimeout(timeout)\n            .build();\n        this.baseUrl = baseUrl;\n        this.timeout = timeout;\n    }\n\n    public CompletableFuture<String> get(String path) {\n        HttpRequest req = HttpRequest.newBuilder()\n            .uri(URI.create(baseUrl + path))\n            .timeout(timeout)\n            .GET()\n            .build();\n        return client.sendAsync(req, HttpResponse.BodyHandlers.ofString())\n            .thenApply(HttpResponse::body);\n    }\n\n    public CompletableFuture<String> post(String path, String body) {\n        HttpRequest req = HttpRequest.newBuilder()\n            .uri(URI.create(baseUrl + path))\n            .header("Content-Type", "application/json")\n            .timeout(timeout)\n            .POST(HttpRequest.BodyPublishers.ofString(body))\n            .build();\n        return client.sendAsync(req, HttpResponse.BodyHandlers.ofString())\n            .thenApply(HttpResponse::body);\n    }\n}\n`,
  'src/java/ConfigLoader.java': `package com.example.config;\n\nimport java.io.IOException;\nimport java.io.InputStream;\nimport java.nio.file.Files;\nimport java.nio.file.Path;\nimport java.util.Properties;\n\npublic class ConfigLoader {\n    private final Properties props = new Properties();\n\n    public ConfigLoader(Path path) throws IOException {\n        try (InputStream is = Files.newInputStream(path)) {\n            props.load(is);\n        }\n    }\n\n    public String getString(String key, String defaultValue) {\n        return props.getProperty(key, defaultValue);\n    }\n\n    public int getInt(String key, int defaultValue) {\n        String val = props.getProperty(key);\n        return val != null ? Integer.parseInt(val) : defaultValue;\n    }\n\n    public boolean getBoolean(String key, boolean defaultValue) {\n        String val = props.getProperty(key);\n        return val != null ? Boolean.parseBoolean(val) : defaultValue;\n    }\n}\n`,

  // ── C# ──
  'src/csharp/EmailService.cs': `using System;\nusing System.Net;\nusing System.Net.Mail;\nusing System.Threading.Tasks;\n\nnamespace Services\n{\n    public class EmailService\n    {\n        private readonly string smtpHost;\n        private readonly int smtpPort;\n        private readonly string username;\n        private readonly string password;\n\n        public EmailService(string smtpHost, int smtpPort, string username, string password)\n        {\n            this.smtpHost = smtpHost;\n            this.smtpPort = smtpPort;\n            this.username = username;\n            this.password = password;\n        }\n\n        public async Task SendAsync(string to, string subject, string body)\n        {\n            using var client = new SmtpClient(smtpHost, smtpPort)\n            {\n                Credentials = new NetworkCredential(username, password),\n                EnableSsl = true\n            };\n            var message = new MailMessage(username, to, subject, body);\n            await client.SendMailAsync(message);\n        }\n\n        public async Task SendBatchAsync(string[] recipients, string subject, string body)\n        {\n            foreach (var to in recipients)\n            {\n                await SendAsync(to, subject, body);\n            }\n        }\n    }\n}\n`,
}
const corpus = []
for (const [fp, content] of Object.entries(files)) {
  const full = path.join(tempDir, fp)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
  corpus.push({ filePath: path.join(tempDir, fp), content })
}

// 2. 插件索引（P 组）
const config = getConfig({
  milvusAddress: 'localhost:19530',
  milvusCollection: COLLECTION,
  milvusDim: 768,
  embeddingEndpoint: 'http://localhost:11434/api/embed',
  embeddingModel: 'nomic-embed-text',
  indexRoot: tempDir,
  merkleFilePath: path.join(tempDir, '.merkle.json'),
  hybridMode: true,
})
const embeddingClient = new EmbeddingClient(config.embedding)
const milvus = new MilvusService({ address: config.milvusAddress, token: config.milvusToken, collection: config.milvusCollection, dim: config.milvusDim, embeddingClient, hybridMode: config.hybridMode, bm25RrfK: config.bm25RrfK })
const tracker = new HashTracker(config.merkleFilePath)
await runIndex(config, milvus, tracker, { mode: 'full' })

// 3. 三组检索
const queries = await loadDataset(path.join(__dirname, 'sample-dataset.json'))
// 数据集里的 relevantFiles 是相对路径，检索结果是绝对路径，这里统一解析为绝对路径
for (const q of queries) {
  q.relevantFiles = q.relevantFiles.map((f) => path.resolve(tempDir, f))
}
const METRICS = {
  'recall@10': (r, q) => recallAtK(r, q.relevantFiles, 10),
  'mrr': (r, q) => mrr(r, q.relevantFiles),
  'ndcg@10': (r, q) => ndcgAtK(r, q.relevantFiles, 10),
  'hit@1': (r, q) => hitAtK(r, q.relevantFiles, 1),
  'precision@10': (r, q) => precisionAtK(r, q.relevantFiles, 10),
}
const groups = { G: [], R: [], P: [] }
for (const q of queries) {
  const g = grepBaseline(q.query, corpus, TOPK)
  const r = await naiveRagBaseline(q.query, corpus, embeddingClient, TOPK)
  const s = await milvus.search(q.query, TOPK)
  const p = [...new Set(s.map((x) => x.filePath))]
  groups.G.push(g); groups.R.push(r); groups.P.push(p)
}

// 4. 逐指标统计（P vs G、P vs R）
const rng = mulberry32(42)
const lines = ['# 离线检索质量评测报告', '']
for (const [name, fn] of Object.entries(METRICS)) {
  const per = {}
  for (const key of ['G', 'R', 'P']) per[key] = queries.map((q, i) => fn(groups[key][i], q))
  lines.push(`## ${name}`, '')
  lines.push(`| 组 | 均值 |`, '|---|---|')
  for (const key of ['G', 'R', 'P']) lines.push(`| ${key} | ${mean(per[key]).toFixed(4)} |`)
  lines.push('')
  for (const [other, label] of [['G', 'P vs G'], ['R', 'P vs R']]) {
    const x = per.P, y = per[other]
    const { p, n } = wilcoxonSignedRank(x, y)
    const ci = bootstrapMeanDiffCi(x, y, { nBoot: 1000, rng })
    const d = cliffsDelta(x, y)
    lines.push(`- ${label}: mean diff ${ci.mean.toFixed(4)} (95% CI [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]), Wilcoxon p=${Number.isNaN(p) ? 'n/a' : p.toExponential(2)}, Cliff's Δ=${d.toFixed(3)}, n=${n}`)
  }
  lines.push('')
}
await mkdir(path.join(__dirname, 'output'), { recursive: true })
const reportPath = path.join(__dirname, 'output', 'report.md')
await writeFile(reportPath, lines.join('\n'), 'utf-8')
console.log(lines.join('\n'))
console.log(`Report written to ${reportPath}`)

// 5. 清理
const { MilvusClient } = await import('@zilliz/milvus2-sdk-node')
const client = new MilvusClient({ address: config.milvusAddress })
await client.connectPromise
await client.dropCollection({ collection_name: COLLECTION })
await rm(tempDir, { recursive: true, force: true })
console.log('=== Eval completed successfully ===')

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length }
