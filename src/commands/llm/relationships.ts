import chalk from 'chalk';
import TargetCommand from '../relationships/annotate.js';

export default class LlmRelationships extends TargetCommand {
  static override description = '[Deprecated] Use "relationships annotate" instead';
  static override hidden = true;

  public async run(): Promise<void> {
    process.stderr.write(
      chalk.yellow('Warning: "squint llm relationships" is deprecated. Use "squint relationships annotate" instead.\n')
    );
    return super.run();
  }
}
