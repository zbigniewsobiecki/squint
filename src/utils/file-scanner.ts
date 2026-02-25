import path from 'node:path';
import { glob } from 'glob';

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

const FILE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx'];

export interface ScanOptions {
  ignorePatterns?: string[];
}

export async function scanDirectory(directory: string, options: ScanOptions = {}): Promise<string[]> {
  const absoluteDir = path.resolve(directory);
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

  const pattern = `**/*.{${FILE_EXTENSIONS.join(',')}}`;

  const files = await glob(pattern, {
    cwd: absoluteDir,
    absolute: true,
    ignore: ignorePatterns,
    nodir: true,
  });

  return files.sort();
}

export function getLanguageFromExtension(filePath: string): 'typescript' | 'javascript' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') {
    return 'typescript';
  }
  return 'javascript';
}
