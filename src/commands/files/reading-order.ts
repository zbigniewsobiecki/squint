import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

export default class ReadingOrder extends Command {
  static override description = 'Output files in optimal reading order (dependency-sorted, leaves first)';

  static override examples = [
    '<%= config.bin %> files reading-order',
    '<%= config.bin %> files reading-order --show-depth',
    '<%= config.bin %> files reading-order --reverse',
    '<%= config.bin %> files reading-order --exclude-tests',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    reverse: Flags.boolean({
      description: 'Output in reverse order (entry points first)',
      default: false,
    }),
    'show-depth': Flags.boolean({
      description: 'Show depth level for each file',
      default: false,
    }),
    'exclude-tests': Flags.boolean({
      description: 'Exclude test files from output',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ReadingOrder);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(chalk.red(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`));
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to open database: ${message}`));
    }

    try {
      const files = db.getFilesInReadingOrder({
        excludeTests: flags['exclude-tests'],
      });

      if (files.length === 0) {
        this.log(chalk.yellow('No files found in database.'));
        return;
      }

      // Reverse if requested
      const orderedFiles = flags.reverse ? [...files].reverse() : files;

      if (flags['show-depth']) {
        // Group by depth
        const byDepth = new Map<number, typeof files>();
        for (const file of orderedFiles) {
          const depth = file.depth;
          if (!byDepth.has(depth)) {
            byDepth.set(depth, []);
          }
          byDepth.get(depth)!.push(file);
        }

        // Get sorted depths
        const depths = [...byDepth.keys()].sort((a, b) => flags.reverse ? b - a : a - b);

        for (const depth of depths) {
          const depthFiles = byDepth.get(depth)!;
          const hasCycles = depthFiles.some(f => f.cycleGroup !== undefined);

          if (hasCycles) {
            this.log(chalk.gray(`# Depth ${depth} (cycles detected)`));
          } else {
            const description = depth === 0 ? '(no internal imports)' : '';
            this.log(chalk.gray(`# Depth ${depth} ${description}`));
          }

          for (const file of depthFiles) {
            if (file.cycleGroup !== undefined) {
              this.log(`${file.path} ${chalk.yellow(`[cycle ${file.cycleGroup}]`)}`);
            } else {
              this.log(file.path);
            }
          }
          this.log('');
        }
      } else {
        // Flat output
        for (const file of orderedFiles) {
          if (file.cycleGroup !== undefined) {
            this.log(`${file.path} ${chalk.yellow(`[cycle ${file.cycleGroup}]`)}`);
          } else {
            this.log(file.path);
          }
        }
      }

      // Summary
      const cycleCount = files.filter(f => f.cycleGroup !== undefined).length;
      const maxDepth = Math.max(...files.map(f => f.depth));

      this.log('');
      this.log(chalk.gray(`${files.length} files, max depth ${maxDepth}${cycleCount > 0 ? `, ${cycleCount} in cycles` : ''}`));
    } finally {
      db.close();
    }
  }
}
