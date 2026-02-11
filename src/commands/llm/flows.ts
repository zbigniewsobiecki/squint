import chalk from 'chalk';
import TargetCommand from '../flows/generate.js';

export default class LlmFlows extends TargetCommand {
  static override description = '[Deprecated] Use "flows generate" instead';
  static override hidden = true;

  public async run(): Promise<void> {
    process.stderr.write(
      chalk.yellow('Warning: "squint llm flows" is deprecated. Use "squint flows generate" instead.\n')
    );
    return super.run();
  }
}
