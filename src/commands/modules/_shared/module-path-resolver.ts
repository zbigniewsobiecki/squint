/**
 * Module path resolution utilities.
 *
 * Resolves module paths against a lookup map with fuzzy matching support.
 */

export interface PathResolvable {
  id: number;
  fullPath: string;
}

/**
 * Resolve a module path against the lookup map.
 * Tries exact match first, then falls back to matching by final segment(s).
 * Returns undefined if no match or ambiguous (multiple candidates).
 *
 * @param modulePath The module path to resolve
 * @param moduleByPath Map of full paths to modules
 * @param constrainPrefix Optional prefix to constrain fuzzy matches
 */
export function resolveModulePath<T extends PathResolvable>(
  modulePath: string,
  moduleByPath: Map<string, T>,
  constrainPrefix?: string
): T | undefined {
  // Exact match
  const exact = moduleByPath.get(modulePath);
  if (exact) return exact;

  // Fuzzy: match by final segment(s)
  const segments = modulePath.split('.');
  const candidates: T[] = [];

  for (const [fullPath, mod] of moduleByPath) {
    if (constrainPrefix && !fullPath.startsWith(constrainPrefix)) continue;
    const fullSegments = fullPath.split('.');
    // Check if the path's segments match the tail of the full path
    if (fullSegments.length >= segments.length) {
      const tail = fullSegments.slice(fullSegments.length - segments.length);
      if (tail.every((s, i) => s === segments[i])) {
        candidates.push(mod);
      }
    }
  }

  // Only return if exactly one candidate (avoid ambiguity)
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface DirectoryHints {
  [moduleId: number]: string[];
}

export interface ModuleWithMembers {
  id: number;
  members: Array<{ filePath: string }>;
}

/**
 * Compute directory hints for each module based on current member file paths.
 * Returns the top 3 directories per module by member count.
 *
 * @param modules Array of modules with their members
 * @returns Map of module ID to top 3 directories
 */
export function computeModuleDirectoryHints(modules: ModuleWithMembers[]): Map<number, string[]> {
  const hints = new Map<number, string[]>();

  for (const mod of modules) {
    if (mod.members.length === 0) continue;

    const dirCounts = new Map<string, number>();
    for (const m of mod.members) {
      const dir = m.filePath.split('/').slice(0, -1).join('/');
      if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    hints.set(
      mod.id,
      Array.from(dirCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([dir]) => dir)
    );
  }

  return hints;
}
