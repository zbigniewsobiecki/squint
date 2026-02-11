import chalk from 'chalk';
import TargetCommand from '../features/generate.js';

export default class LlmFeatures extends TargetCommand {
  static override description = '[Deprecated] Use "features generate" instead';
  static override hidden = true;

  public async run(): Promise<void> {
    process.stderr.write(
      chalk.yellow('Warning: "squint llm features" is deprecated. Use "squint features generate" instead.\n')
    );
    return super.run();
  }
}
