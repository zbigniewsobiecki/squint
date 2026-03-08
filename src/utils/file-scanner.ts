import path from 'node:path';
import { glob } from 'glob';
import { LanguageRegistry } from '../parser/language-adapter.js';
// Import the TypeScriptAdapter to ensure it's registered
import '../parser/adapters/typescript-adapter.js';

export const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/out/**',
];

export interface ScanOptions {
  ignorePatterns?: string[];
}

export async function scanDirectory(directory: string, options: ScanOptions = {}): Promise<string[]> {
  const absoluteDir = path.resolve(directory);
  const registry = LanguageRegistry.getInstance();

  // Get file extensions from registry
  const extensions = registry.getAllExtensions();

  // Merge language-specific ignore patterns with base patterns and user-provided patterns
  const languageIgnorePatterns = registry.getAllIgnorePatterns();
  const basePatterns = DEFAULT_IGNORE_PATTERNS;
  const mergedIgnorePatterns = [...new Set([...basePatterns, ...languageIgnorePatterns])];
  const ignorePatterns = options.ignorePatterns ?? mergedIgnorePatterns;

  const pattern = `**/*.{${extensions.join(',')}}`;

  const files = await glob(pattern, {
    cwd: absoluteDir,
    absolute: true,
    ignore: ignorePatterns,
    nodir: true,
  });

  return files.sort();
}

export function getLanguageFromExtension(filePath: string): string {
  const registry = LanguageRegistry.getInstance();
  const ext = path.extname(filePath).toLowerCase();
  const adapter = registry.getAdapter(ext);

  if (!adapter) {
    return 'unknown';
  }

  // For backward compatibility with TypeScript adapter, distinguish between typescript and javascript
  if (adapter.languageId === 'typescript') {
    return ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';
  }

  return adapter.languageId;
}
