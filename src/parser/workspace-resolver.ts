import fs from 'node:fs';
import path from 'node:path';

export interface WorkspacePackage {
  name: string;
  dir: string; // Absolute path to package directory
  entryPoint: string; // Absolute path to resolved entry file
  exports?: Record<string, unknown>; // package.json exports field
}

export interface WorkspaceMap {
  packages: Map<string, WorkspacePackage>;
  rootDir: string;
}

// Module-level cache keyed by startDir
const workspaceMapCache = new Map<string, WorkspaceMap | null>();

const EXTENSIONS_TO_TRY = ['.ts', '.tsx', '.js', '.jsx'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

/**
 * Build a workspace map by detecting workspace configuration and resolving packages.
 */
export function buildWorkspaceMap(startDir: string, knownFiles: Set<string>): WorkspaceMap | null {
  if (workspaceMapCache.has(startDir)) {
    return workspaceMapCache.get(startDir) ?? null;
  }

  const result = buildWorkspaceMapUncached(startDir, knownFiles);
  workspaceMapCache.set(startDir, result);
  return result;
}

/**
 * Clear the workspace map cache. Useful for testing.
 */
export function clearWorkspaceMapCache(): void {
  workspaceMapCache.clear();
}

function buildWorkspaceMapUncached(startDir: string, knownFiles: Set<string>): WorkspaceMap | null {
  // Walk up from startDir looking for workspace config
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const patterns = getWorkspacePatterns(dir);
    if (patterns !== null) {
      const packages = resolveWorkspacePackages(dir, patterns, knownFiles);
      if (packages.size > 0) {
        return { packages, rootDir: dir };
      }
      // Found a workspace config but no packages resolved — stop looking
      return null;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Try to read workspace patterns from a directory.
 * Checks pnpm-workspace.yaml first, then package.json workspaces field.
 */
function getWorkspacePatterns(dir: string): string[] | null {
  // Check pnpm-workspace.yaml
  const pnpmPath = path.join(dir, 'pnpm-workspace.yaml');
  try {
    const content = fs.readFileSync(pnpmPath, 'utf-8');
    const patterns = parsePnpmWorkspaceYaml(content);
    if (patterns.length > 0) return patterns;
  } catch {
    // not found
  }

  // Check package.json workspaces field
  const pkgPath = path.join(dir, 'package.json');
  try {
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    if (pkg.workspaces) {
      // Handle both string[] and { packages: string[] } formats
      if (Array.isArray(pkg.workspaces)) {
        return pkg.workspaces;
      }
      if (pkg.workspaces.packages && Array.isArray(pkg.workspaces.packages)) {
        return pkg.workspaces.packages;
      }
    }
  } catch {
    // not found
  }

  return null;
}

/**
 * Parse pnpm-workspace.yaml to extract package patterns.
 * Uses simple regex parsing to avoid YAML dependency.
 */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    // New top-level key ends the packages block
    if (inPackages && trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('#')) {
      break;
    }
    if (inPackages && trimmed.startsWith('-')) {
      // Extract pattern: - "pattern" or - 'pattern' or - pattern
      const match = trimmed.match(/^-\s+["']?([^"']+)["']?\s*$/);
      if (match) {
        patterns.push(match[1].trim());
      }
    }
  }
  return patterns;
}

/**
 * Resolve workspace packages from glob patterns.
 */
function resolveWorkspacePackages(
  rootDir: string,
  patterns: string[],
  knownFiles: Set<string>
): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();

  for (const pattern of patterns) {
    // Skip negation patterns
    if (pattern.startsWith('!')) continue;

    const dirs = expandWorkspacePattern(rootDir, pattern);
    for (const pkgDir of dirs) {
      const pkg = readWorkspacePackage(pkgDir, knownFiles);
      if (pkg) {
        packages.set(pkg.name, pkg);
      }
    }
  }

  return packages;
}

/**
 * Expand a workspace glob pattern to actual directories.
 * Handles simple patterns like "packages/*" and "apps/*".
 */
function expandWorkspacePattern(rootDir: string, pattern: string): string[] {
  const dirs: string[] = [];

  if (pattern.endsWith('/*') || pattern.endsWith('\\*')) {
    // Simple glob: "packages/*" — list directories under packages/
    const parentDir = path.resolve(rootDir, pattern.slice(0, -2));
    try {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.push(path.join(parentDir, entry.name));
        }
      }
    } catch {
      // directory doesn't exist
    }
  } else if (pattern.includes('*')) {
    // More complex glob like "packages/**" — treat same as "packages/*" for simplicity
    const beforeStar = pattern.split('*')[0].replace(/\/+$/, '');
    const parentDir = path.resolve(rootDir, beforeStar);
    try {
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.push(path.join(parentDir, entry.name));
        }
      }
    } catch {
      // directory doesn't exist
    }
  } else {
    // Exact directory path
    const dir = path.resolve(rootDir, pattern);
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        dirs.push(dir);
      }
    } catch {
      // doesn't exist
    }
  }

  return dirs;
}

/**
 * Read a package.json in a directory and resolve its entry point.
 */
function readWorkspacePackage(pkgDir: string, knownFiles: Set<string>): WorkspacePackage | null {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    const content = fs.readFileSync(pkgJsonPath, 'utf-8');
    pkg = JSON.parse(content);
  } catch {
    return null;
  }

  const name = pkg.name as string | undefined;
  if (!name) return null;

  const entryPoint = resolvePackageEntryPoint(pkgDir, pkg, knownFiles);
  if (!entryPoint) return null;

  return {
    name,
    dir: pkgDir,
    entryPoint,
    exports: pkg.exports as Record<string, unknown> | undefined,
  };
}

/**
 * Resolve the entry point of a package using standard Node resolution order.
 */
function resolvePackageEntryPoint(
  pkgDir: string,
  pkg: Record<string, unknown>,
  knownFiles: Set<string>
): string | null {
  const candidates: string[] = [];

  // 1. exports["."] field
  if (pkg.exports) {
    const exportsEntry = resolveExportsEntry(pkg.exports as Record<string, unknown>, '.');
    if (exportsEntry) {
      candidates.push(path.resolve(pkgDir, exportsEntry));
    }
  }

  // 2. main field
  if (typeof pkg.main === 'string') {
    candidates.push(path.resolve(pkgDir, pkg.main));
  }

  // 3. types / typings field (for type-only packages)
  if (typeof pkg.types === 'string') {
    candidates.push(path.resolve(pkgDir, pkg.types));
  }
  if (typeof pkg.typings === 'string') {
    candidates.push(path.resolve(pkgDir, pkg.typings));
  }

  // 4. Fallback: src/index.ts, index.ts, index.js
  candidates.push(path.join(pkgDir, 'src', 'index.ts'));
  for (const indexFile of INDEX_FILES) {
    candidates.push(path.join(pkgDir, indexFile));
  }

  // Try each candidate with extension resolution
  for (const candidate of candidates) {
    const resolved = resolveWithExtensions(candidate, knownFiles);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Resolve a subpath from package.json exports field.
 */
function resolveExportsEntry(exports: unknown, subpath: string): string | null {
  if (typeof exports === 'string') {
    // String shorthand: "exports": "./src/index.ts"
    return subpath === '.' ? exports : null;
  }

  if (typeof exports !== 'object' || exports === null) return null;

  const exportsObj = exports as Record<string, unknown>;

  // Check for subpath key
  const entry = exportsObj[subpath];
  if (entry !== undefined) {
    return resolveExportsValue(entry);
  }

  // If subpath is "." and exports has condition keys (import, default, require)
  if (subpath === '.') {
    return resolveExportsValue(exports);
  }

  // Check for wildcard patterns
  for (const [pattern, value] of Object.entries(exportsObj)) {
    if (pattern.includes('*')) {
      const prefix = pattern.split('*')[0];
      const suffix = pattern.split('*')[1] || '';
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
        const resolved = resolveExportsValue(value);
        if (resolved) {
          return resolved.replace('*', wildcard);
        }
      }
    }
  }

  return null;
}

/**
 * Resolve an exports value which may be a string, condition object, or nested structure.
 */
function resolveExportsValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;

  const obj = value as Record<string, unknown>;

  // Try condition keys in priority order
  for (const key of ['import', 'default', 'require', 'types']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const nested = resolveExportsValue(obj[key]);
      if (nested) return nested;
    }
  }

  return null;
}

/**
 * Try to resolve a file path with extension fallbacks.
 */
function resolveWithExtensions(filePath: string, knownFiles: Set<string>): string | null {
  if (knownFiles.has(filePath)) return filePath;

  for (const ext of EXTENSIONS_TO_TRY) {
    if (knownFiles.has(filePath + ext)) return filePath + ext;
  }

  // Handle .js → .ts resolution
  const ext = path.extname(filePath);
  if (ext === '.js' || ext === '.jsx') {
    const withoutExt = filePath.slice(0, -ext.length);
    const tsExt = ext === '.js' ? '.ts' : '.tsx';
    if (knownFiles.has(withoutExt + tsExt)) return withoutExt + tsExt;
    const altTsExt = ext === '.js' ? '.tsx' : '.ts';
    if (knownFiles.has(withoutExt + altTsExt)) return withoutExt + altTsExt;
  }

  // Try index files in directory
  for (const indexFile of INDEX_FILES) {
    const indexPath = path.join(filePath, indexFile);
    if (knownFiles.has(indexPath)) return indexPath;
  }

  return null;
}

/**
 * Resolve a workspace import specifier to an absolute file path.
 */
export function resolveWorkspaceImport(
  source: string,
  workspaceMap: WorkspaceMap,
  knownFiles: Set<string>
): string | undefined {
  // Parse import specifier
  const { packageName, subpath } = parseImportSpecifier(source);

  const pkg = workspaceMap.packages.get(packageName);
  if (!pkg) return undefined;

  // No subpath: return entry point
  if (!subpath) {
    return pkg.entryPoint;
  }

  // Check exports field for subpath patterns
  if (pkg.exports) {
    const subpathWithDot = `./${subpath}`;
    const exportResolved = resolveExportsEntry(pkg.exports, subpathWithDot);
    if (exportResolved) {
      const absPath = path.resolve(pkg.dir, exportResolved);
      const resolved = resolveWithExtensions(absPath, knownFiles);
      if (resolved) return resolved;
    }
  }

  // Resolve relative to package directory
  const absPath = path.resolve(pkg.dir, subpath);
  const resolved = resolveWithExtensions(absPath, knownFiles);
  if (resolved) return resolved;

  // Try under src/
  const srcPath = path.resolve(pkg.dir, 'src', subpath);
  const srcResolved = resolveWithExtensions(srcPath, knownFiles);
  if (srcResolved) return srcResolved;

  return undefined;
}

/**
 * Parse a bare import specifier into package name and optional subpath.
 */
function parseImportSpecifier(source: string): { packageName: string; subpath: string | null } {
  if (source.startsWith('@')) {
    // Scoped: @scope/name or @scope/name/sub/path
    const parts = source.split('/');
    if (parts.length < 2) {
      return { packageName: source, subpath: null };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const subpath = parts.length > 2 ? parts.slice(2).join('/') : null;
    return { packageName, subpath };
  }

  // Unscoped: name or name/sub/path
  const slashIndex = source.indexOf('/');
  if (slashIndex === -1) {
    return { packageName: source, subpath: null };
  }
  return {
    packageName: source.slice(0, slashIndex),
    subpath: source.slice(slashIndex + 1),
  };
}
