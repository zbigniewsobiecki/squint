import chalk from 'chalk';
import TargetCommand from '../interactions/generate.js';

export default class LlmInteractions extends TargetCommand {
  static override description = '[Deprecated] Use "interactions generate" instead';
  static override hidden = true;

  public async run(): Promise<void> {
    process.stderr.write(
      chalk.yellow('Warning: "squint llm interactions" is deprecated. Use "squint interactions generate" instead.\n')
    );
    return super.run();
  }
}
