import type { IndexDatabase } from '../../../db/database-facade.js';
import { readSourceLines } from '../../_shared/source-reader.js';

export interface MountResolverResult {
  routeMounts: Map<string, string>; // routeFilePath → mountPrefix (e.g., '/api/auth')
  clientBaseUrl: string | null; // base path component (e.g., '/api')
}

/**
 * Regex to parse Express `.use('/prefix', routerVar)` calls.
 * Captures the string prefix argument (single or double quotes).
 */
const USE_MOUNT_RE = /\.use\(\s*['"]([^'"]+)['"]\s*,/;

/**
 * Regex to parse `baseURL: '/api'` or `baseUrl: '/api'` patterns.
 * Also handles `baseURL: "http://host:port/api"`.
 */
const BASE_URL_RE = /base[Uu][Rr][Ll]\s*[:=]\s*['"]([^'"]+)['"]/;

/**
 * Extract the path component from a URL-like string.
 * "http://localhost:3000/api" → "/api"
 * "/api" → "/api"
 */
function extractPathComponent(url: string): string {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const parsed = new URL(url);
      return parsed.pathname === '/' ? '' : parsed.pathname;
    }
  } catch {
    // Not a valid URL, treat as path
  }
  return url;
}

/**
 * Join two path segments, avoiding double slashes.
 * joinPaths('/api', '/auth') → '/api/auth'
 * joinPaths('/api/', '/auth') → '/api/auth'
 */
function joinPaths(base: string, suffix: string): string {
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return cleanBase + cleanSuffix;
}

/**
 * Resolve Express mount prefixes and client baseURLs from the DB's import/usage graph.
 *
 * Server-side mount detection:
 * 1. Query orphan module-scope method calls (e.g., `app.use('/api/auth', authRoutes)`)
 * 2. Read source lines and regex-parse for `.use('/prefix', routerVar)`
 * 3. Follow the symbol's definition → file to get the target route file
 * 4. Compose nested mounts via BFS
 *
 * Client-side baseURL detection:
 * 1. Query files importing 'axios' or containing baseURL patterns
 * 2. Read those files, regex-parse for `baseURL: '/api'`
 * 3. Extract the path component
 */
export async function resolveMounts(db: IndexDatabase): Promise<MountResolverResult> {
  const routeMounts = new Map<string, string>();
  let clientBaseUrl: string | null = null;

  // --- Server-side mount detection ---
  const mountCalls = db.dependencies.getModuleScopeMountCalls();

  // Build adjacency: filePath → Array<{ prefix, targetFilePath }>
  // Each entry means "file at filePath mounts targetFilePath at prefix"
  const mountEdges: Array<{ fromFile: string; prefix: string; targetFile: string }> = [];

  for (const call of mountCalls) {
    const resolvedPath = db.resolveFilePath(call.filePath);
    const lines = await readSourceLines(resolvedPath, call.usageLine, call.usageLine);
    if (lines.length === 0 || lines[0] === '<source code not available>') continue;

    const line = lines[0];
    const match = USE_MOUNT_RE.exec(line);
    if (!match) continue;

    const prefix = match[1];
    // Ensure the symbol used in this call maps to the referenced file
    mountEdges.push({
      fromFile: call.filePath,
      prefix,
      targetFile: call.referencedFilePath,
    });
  }

  // BFS to compose nested mounts
  // Build graph: targetFile → Array<{ fromFile, prefix }>
  const incomingMounts = new Map<string, Array<{ fromFile: string; prefix: string }>>();
  const allFromFiles = new Set<string>();

  for (const edge of mountEdges) {
    const existing = incomingMounts.get(edge.targetFile) ?? [];
    existing.push({ fromFile: edge.fromFile, prefix: edge.prefix });
    incomingMounts.set(edge.targetFile, existing);
    allFromFiles.add(edge.fromFile);
  }

  // Find root mount files (files that mount others but are not themselves mounted)
  const mountedFiles = new Set(incomingMounts.keys());
  const rootFiles = new Set<string>();
  for (const fromFile of allFromFiles) {
    if (!mountedFiles.has(fromFile)) {
      rootFiles.add(fromFile);
    }
  }

  // BFS from root files to compose prefixes
  // rootFile itself has no prefix; files it mounts inherit the prefix
  const filePrefixes = new Map<string, string>();
  for (const root of rootFiles) {
    filePrefixes.set(root, '');
  }

  const queue: string[] = [...rootFiles];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const currentPrefix = filePrefixes.get(current) ?? '';

    // Find all files mounted by current
    for (const edge of mountEdges) {
      if (edge.fromFile !== current) continue;

      const composedPrefix = currentPrefix ? joinPaths(currentPrefix, edge.prefix) : edge.prefix;
      const existingPrefix = filePrefixes.get(edge.targetFile);

      // Only set if not already set (first path wins in BFS)
      if (existingPrefix === undefined) {
        filePrefixes.set(edge.targetFile, composedPrefix);
        queue.push(edge.targetFile);
      }
    }
  }

  // Populate routeMounts: only files that are mounted (have a non-empty prefix)
  for (const [filePath, prefix] of filePrefixes) {
    if (prefix) {
      routeMounts.set(filePath, prefix);
    }
  }

  // --- Client-side baseURL detection ---
  clientBaseUrl = await detectClientBaseUrl(db);

  return { routeMounts, clientBaseUrl };
}

/**
 * Detect client-side baseURL from files that import axios or define API clients.
 */
async function detectClientBaseUrl(db: IndexDatabase): Promise<string | null> {
  // Find files that import from 'axios' or similar HTTP client libraries
  const conn = db.getConnection();
  const axiosImports = conn
    .prepare(`
    SELECT DISTINCT f.path AS filePath
    FROM imports i
    JOIN files f ON i.from_file_id = f.id
    WHERE i.source IN ('axios', 'axios/index', './axios', '../axios')
      AND i.is_external = 1
  `)
    .all() as Array<{ filePath: string }>;

  for (const { filePath } of axiosImports) {
    const resolvedPath = db.resolveFilePath(filePath);
    const lines = await readSourceLines(resolvedPath, 1, 200);
    const content = lines.join('\n');

    const match = BASE_URL_RE.exec(content);
    if (match) {
      const raw = match[1];
      const pathComponent = extractPathComponent(raw);
      if (pathComponent && pathComponent !== '/') {
        return pathComponent;
      }
    }
  }

  // Also scan for files with 'api' in the path that might define an HTTP client
  const apiClientFiles = conn
    .prepare(`
    SELECT path AS filePath FROM files
    WHERE path LIKE '%api%client%'
       OR path LIKE '%http%client%'
       OR path LIKE '%api%service%'
       OR path LIKE '%services/api%'
  `)
    .all() as Array<{ filePath: string }>;

  for (const { filePath } of apiClientFiles) {
    const resolvedPath = db.resolveFilePath(filePath);
    const lines = await readSourceLines(resolvedPath, 1, 200);
    const content = lines.join('\n');

    const match = BASE_URL_RE.exec(content);
    if (match) {
      const raw = match[1];
      const pathComponent = extractPathComponent(raw);
      if (pathComponent && pathComponent !== '/') {
        return pathComponent;
      }
    }
  }

  return null;
}
