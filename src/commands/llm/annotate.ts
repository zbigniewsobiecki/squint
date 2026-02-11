import chalk from 'chalk';
import TargetCommand from '../symbols/annotate.js';

export default class LlmAnnotate extends TargetCommand {
  static override description = '[Deprecated] Use "symbols annotate" instead';
  static override hidden = true;

  public async run(): Promise<void> {
    process.stderr.write(
      chalk.yellow('Warning: "squint llm annotate" is deprecated. Use "squint symbols annotate" instead.\n')
    );
    return super.run();
  }
}
