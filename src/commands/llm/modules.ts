import chalk from 'chalk';
import TargetCommand from '../modules/generate.js';

export default class LlmModules extends TargetCommand {
  static override description = '[Deprecated] Use "modules generate" instead';
  static override hidden = true;

  public async run(): Promise<void> {
    process.stderr.write(
      chalk.yellow('Warning: "squint llm modules" is deprecated. Use "squint modules generate" instead.\n')
    );
    return super.run();
  }
}
