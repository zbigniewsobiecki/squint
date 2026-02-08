import { exec } from 'node:child_process';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { createServer, startServer } from '../web/server.js';
import { SharedFlags, openDatabase } from './_shared/index.js';

export default class Browse extends Command {
  static override description = 'Launch interactive code browser for indexed database';

  static override examples = [
    '<%= config.bin %> browse',
    '<%= config.bin %> browse -d ./my-index.db',
    '<%= config.bin %> browse -p 8080',
    '<%= config.bin %> browse --no-open',
  ];

  static override flags = {
    database: SharedFlags.database,
    port: Flags.integer({
      char: 'p',
      description: 'Server port',
      default: 3000,
    }),
    'no-open': Flags.boolean({
      description: 'Do not automatically open browser',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Browse);

    // Open database
    this.log(chalk.blue(`Opening database: ${flags.database}`));
    const db = await openDatabase(flags.database, this);

    // Get stats to verify database is valid
    try {
      const stats = db.getStats();
      this.log(
        chalk.gray(
          `  ${stats.files} files, ${stats.definitions} definitions, ${stats.imports} imports, ${stats.usages} usages`
        )
      );
    } catch (error) {
      db.close();
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Database appears to be invalid or empty: ${message}`));
    }

    // Create and start server
    const port = flags.port;
    const server = createServer(db, port);

    try {
      await startServer(server, port);
    } catch (error) {
      db.close();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EADDRINUSE')) {
        this.error(chalk.red(`Port ${port} is already in use. Try a different port with -p <port>`));
      }
      this.error(chalk.red(`Failed to start server: ${message}`));
    }

    const url = `http://localhost:${port}`;
    this.log(chalk.green.bold(`\nServer running at ${url}`));
    this.log(chalk.gray('Press Ctrl+C to stop\n'));

    // Open browser unless --no-open flag is set
    if (!flags['no-open']) {
      this.openBrowser(url);
    }

    // Handle graceful shutdown
    const shutdown = () => {
      this.log(chalk.blue('\nShutting down...'));
      server.close(() => {
        db.close();
        this.log(chalk.green('Server stopped.'));
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep the process running
    await new Promise(() => {
      // Never resolves - waits for SIGINT/SIGTERM
    });
  }

  private openBrowser(url: string): void {
    const platform = process.platform;
    let command: string;

    if (platform === 'darwin') {
      command = `open "${url}"`;
    } else if (platform === 'win32') {
      command = `start "" "${url}"`;
    } else {
      // Linux and others
      command = `xdg-open "${url}"`;
    }

    exec(command, (error) => {
      if (error) {
        this.log(chalk.yellow(`Could not open browser automatically. Please open ${url} manually.`));
      }
    });
  }
}
