import type { MountResolverResult } from './mount-resolver.js';

interface ContractEntry {
  protocol: string;
  role: string;
  key: string;
  normalizedKey?: string;
  details?: string;
}

/**
 * Regex to split an HTTP normalizedKey into method and path.
 * e.g., "GET /vehicles/{param}" → ["GET", "/vehicles/{param}"]
 */
const HTTP_KEY_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i;

/**
 * Join two path segments, avoiding double slashes.
 */
function joinPaths(base: string, suffix: string): string {
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return cleanBase + cleanSuffix;
}

/**
 * Check if a path already starts with the given prefix.
 */
function pathStartsWith(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  // Ensure it's a full segment match: /api must match /api/foo but not /apifoo
  if (path.length === prefix.length) return true;
  return path[prefix.length] === '/';
}

/**
 * Apply mount prefix resolution to contract entries.
 *
 * For HTTP contracts:
 * - Server role: look up filePath in routeMounts, prepend prefix if missing
 * - Client role: if clientBaseUrl exists, prepend it if missing
 * - Non-HTTP contracts: pass through unchanged
 */
export function resolveContractKeys(
  contracts: ContractEntry[],
  filePath: string,
  mountResult: MountResolverResult
): ContractEntry[] {
  return contracts.map((entry) => {
    if (entry.protocol !== 'http') return entry;

    const normalizedKey = entry.normalizedKey ?? entry.key;
    const httpMatch = HTTP_KEY_RE.exec(normalizedKey);
    if (!httpMatch) return entry;

    const method = httpMatch[1].toUpperCase();
    const path = httpMatch[2];

    let resolvedPath = path;

    if (isServerRole(entry.role)) {
      const prefix = mountResult.routeMounts.get(filePath);
      if (prefix && !pathStartsWith(path, prefix)) {
        resolvedPath = joinPaths(prefix, path);
      }
    } else if (isClientRole(entry.role)) {
      if (mountResult.clientBaseUrl && !pathStartsWith(path, mountResult.clientBaseUrl)) {
        resolvedPath = joinPaths(mountResult.clientBaseUrl, path);
      }
    }

    if (resolvedPath === path) return entry;

    return {
      ...entry,
      normalizedKey: `${method} ${resolvedPath}`,
    };
  });
}

function isServerRole(role: string): boolean {
  return role === 'server' || role === 'producer' || role === 'emitter' || role === 'publisher';
}

function isClientRole(role: string): boolean {
  return role === 'client' || role === 'consumer' || role === 'listener' || role === 'subscriber';
}
