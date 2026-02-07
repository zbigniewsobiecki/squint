import { Command } from '@oclif/core';

/**
 * Output data as JSON or plain text based on the json flag.
 * @param command The command instance (for this.log)
 * @param json Whether to output as JSON
 * @param data The data to output (for JSON mode)
 * @param plainFn Function to call for plain text output
 */
export function outputJsonOrPlain<T>(
  command: Command,
  json: boolean,
  data: T,
  plainFn: () => void
): void {
  if (json) {
    command.log(JSON.stringify(data, null, 2));
  } else {
    plainFn();
  }
}

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Create a horizontal separator line.
 */
export function tableSeparator(width: number, char = '─'): string {
  return char.repeat(width);
}

/**
 * Format a line number with consistent width padding.
 */
export function formatLineNumber(line: number, width = 5): string {
  return String(line).padStart(width, ' ');
}
