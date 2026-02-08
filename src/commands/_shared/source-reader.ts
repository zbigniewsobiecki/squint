import fs from 'node:fs/promises';

/**
 * Read specific lines from a source file.
 * @param filePath Path to the source file
 * @param start Start line (1-based, inclusive)
 * @param end End line (1-based, inclusive)
 * @returns Array of source lines, or ['<source code not available>'] on error
 */
export async function readSourceLines(filePath: string, start: number, end: number): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    // Convert to 0-based indexing for array access
    return lines.slice(start - 1, end);
  } catch {
    return ['<source code not available>'];
  }
}

/**
 * Read specific lines from a source file as a single string.
 * @param filePath Path to the source file
 * @param start Start line (1-based, inclusive)
 * @param end End line (1-based, inclusive)
 * @returns Source code string, or '<source code not available>' on error
 */
export async function readSourceAsString(filePath: string, start: number, end: number): Promise<string> {
  const lines = await readSourceLines(filePath, start, end);
  return lines.join('\n');
}

/**
 * Read all lines from a source file.
 * @param filePath Path to the source file
 * @returns Array of all source lines, or empty array on error
 */
export async function readAllLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n');
  } catch {
    return [];
  }
}
