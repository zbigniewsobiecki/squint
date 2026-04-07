import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { CallSiteWithContext, FileShowData, MappedInteraction, SymbolShowData } from './_show-data.js';

/**
 * Renders the output for the `symbols show` command.
 * Consumes typed data objects produced by SymbolShowDataGatherer.
 */
export class SymbolShowRenderer {
  constructor(private command: Command) {}

  // ─── Symbol mode ─────────────────────────────────────────────────────────────

  renderSymbol(data: SymbolShowData): void {
    // Definition section
    this.command.log(chalk.bold('=== Definition ==='));
    this.command.log('');
    this.command.log(`Name:       ${chalk.cyan(data.name)}`);
    this.command.log(`Kind:       ${data.kind}`);
    this.command.log(`File:       ${data.filePath}`);
    this.command.log(`Lines:      ${data.line}-${data.endLine}`);
    this.command.log(`Exported:   ${data.isExported ? 'yes' : 'no'}`);

    // Metadata section
    const metadataKeys = Object.keys(data.metadata);
    if (metadataKeys.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold('=== Metadata ==='));
      this.command.log('');
      for (const key of metadataKeys.sort()) {
        this.command.log(`${key}:`.padEnd(12) + data.metadata[key]);
      }
    }

    // Module section
    if (data.module) {
      this.command.log('');
      this.command.log(chalk.bold('=== Module ==='));
      this.command.log('');
      this.command.log(`${chalk.cyan(data.module.name)} ${chalk.gray(`(${data.module.fullPath})`)}`);
    }

    // Relationships (outgoing)
    if (data.relationships.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Relationships Outgoing (${data.relationships.length}) ===`));
      this.command.log('');
      for (const r of data.relationships) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.command.log(
          `  -> ${chalk.cyan(r.toName)} (${r.toKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.toFilePath}:${r.toLine}`)}`
        );
      }
    }

    // Relationships (incoming)
    if (data.incomingRelationships.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Relationships Incoming (${data.incomingRelationships.length}) ===`));
      this.command.log('');
      for (const r of data.incomingRelationships) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.command.log(
          `  <- ${chalk.cyan(r.fromName)} (${r.fromKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.fromFilePath}:${r.fromLine}`)}`
        );
      }
    }

    // Dependencies
    if (data.dependencies.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Dependencies (${data.dependencies.length}) ===`));
      this.command.log('');
      for (const d of data.dependencies) {
        this.command.log(`  ${chalk.cyan(d.name)} (${d.kind}) ${chalk.gray(`${d.filePath}:${d.line}`)}`);
      }
    }

    // Dependents
    if (data.dependents.count > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Dependents (${data.dependents.sample.length} of ${data.dependents.count}) ===`));
      this.command.log('');
      for (const d of data.dependents.sample) {
        this.command.log(`  ${chalk.cyan(d.name)} (${d.kind}) ${chalk.gray(`${d.filePath}:${d.line}`)}`);
      }
      if (data.dependents.count > data.dependents.sample.length) {
        this.command.log(chalk.gray(`  ... and ${data.dependents.count - data.dependents.sample.length} more`));
      }
    }

    // Flows
    if (data.flows.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Flows (${data.flows.length}) ===`));
      this.command.log('');
      for (const f of data.flows) {
        const stakeholder = f.stakeholder ? ` [${f.stakeholder}]` : '';
        this.command.log(`  ${chalk.cyan(f.name)} (${f.slug})${chalk.gray(stakeholder)}`);
      }
    }

    // Interactions
    this.renderInteractionsSection('Incoming', data.interactions.incoming);
    this.renderInteractionsSection('Outgoing', data.interactions.outgoing);

    // Source code section
    this.command.log('');
    this.command.log(chalk.bold('=== Source Code ==='));
    this.command.log('');
    for (let i = 0; i < data.sourceCode.length; i++) {
      const lineNum = data.line + i;
      const lineNumStr = String(lineNum).padStart(5, ' ');
      this.command.log(`${chalk.gray(lineNumStr)} | ${data.sourceCode[i]}`);
    }

    // Call sites section
    this.renderCallSites(data.callSites);
  }

  // ─── File mode ────────────────────────────────────────────────────────────────

  renderFile(data: FileShowData): void {
    this.command.log(chalk.bold(`=== File: ${data.file} ===`));

    // Symbols
    this.command.log('');
    this.command.log(chalk.bold(`=== Symbols (${data.symbols.length}) ===`));
    this.command.log('');
    for (const s of data.symbols) {
      const exported = s.isExported ? chalk.green('exported') : chalk.gray('internal');
      this.command.log(`  ${chalk.cyan(s.name)} (${s.kind}) ${exported} ${chalk.gray(`L${s.line}-${s.endLine}`)}`);
    }

    // Modules
    if (data.modules.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Modules (${data.modules.length}) ===`));
      this.command.log('');
      for (const m of data.modules) {
        this.command.log(`  ${chalk.cyan(m.name)} ${chalk.gray(`(${m.fullPath})`)}`);
      }
    }

    // Relationships
    if (data.relationships.outgoing.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Relationships Outgoing (${data.relationships.outgoing.length}) ===`));
      this.command.log('');
      for (const r of data.relationships.outgoing) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.command.log(
          `  -> ${chalk.cyan(r.toName)} (${r.toKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.toFilePath}:${r.toLine}`)}`
        );
      }
    }

    if (data.relationships.incoming.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Relationships Incoming (${data.relationships.incoming.length}) ===`));
      this.command.log('');
      for (const r of data.relationships.incoming) {
        const semantic = r.semantic ? ` "${r.semantic}"` : '';
        this.command.log(
          `  <- ${chalk.cyan(r.fromName)} (${r.fromKind}) [${r.relationshipType}]${chalk.gray(semantic)} ${chalk.gray(`${r.fromFilePath}:${r.fromLine}`)}`
        );
      }
    }

    // Interactions
    this.renderInteractionsSection('Incoming', data.interactions.incoming);
    this.renderInteractionsSection('Outgoing', data.interactions.outgoing);

    // Flows
    if (data.flows.length > 0) {
      this.command.log('');
      this.command.log(chalk.bold(`=== Flows (${data.flows.length}) ===`));
      this.command.log('');
      for (const f of data.flows) {
        const stakeholder = f.stakeholder ? ` [${f.stakeholder}]` : '';
        this.command.log(`  ${chalk.cyan(f.name)} (${f.slug})${chalk.gray(stakeholder)}`);
      }
    }
  }

  // ─── Shared sections ──────────────────────────────────────────────────────────

  renderInteractionsSection(label: string, interactions: MappedInteraction[]): void {
    if (interactions.length === 0) return;

    this.command.log('');
    this.command.log(chalk.bold(`=== Interactions ${label} (${interactions.length}) ===`));
    this.command.log('');
    for (const i of interactions) {
      const arrow = i.direction === 'bi' ? '\u2194' : '\u2192';
      const patternLabel =
        i.pattern === 'business' ? chalk.cyan('[business]') : i.pattern === 'utility' ? chalk.yellow('[utility]') : '';
      const sourceLabel = i.source === 'llm-inferred' ? chalk.magenta('[inferred]') : chalk.gray('[ast]');

      const fromShort = i.fromModulePath.split('.').slice(-2).join('.');
      const toShort = i.toModulePath.split('.').slice(-2).join('.');

      this.command.log(`  ${fromShort} ${arrow} ${toShort} ${patternLabel} ${sourceLabel}`);

      if (i.semantic) {
        this.command.log(`    ${chalk.gray(`"${i.semantic}"`)}`);
      }
    }
  }

  private renderCallSites(callSites: CallSiteWithContext[]): void {
    this.command.log('');
    this.command.log(chalk.bold(`=== Call Sites (${callSites.length}) ===`));

    if (callSites.length === 0) {
      this.command.log('');
      this.command.log(chalk.gray('No call sites found.'));
      return;
    }

    for (const callSite of callSites) {
      this.command.log('');
      const location = `${callSite.filePath}:${callSite.line}`;
      const inFunction = callSite.containingFunction ? ` in ${chalk.cyan(callSite.containingFunction)}()` : '';
      this.command.log(`${chalk.yellow(location)}${inFunction}`);
      this.command.log(chalk.gray('\u2500'.repeat(60)));

      for (let i = 0; i < callSite.contextLines.length; i++) {
        const lineNum = callSite.contextStartLine + i;
        const lineNumStr = String(lineNum).padStart(5, ' ');
        const isTargetLine = lineNum === callSite.line;
        const prefix = isTargetLine ? chalk.red('>') : ' ';
        const line = callSite.contextLines[i];
        const formattedLine = isTargetLine ? chalk.white(line) : line;
        this.command.log(`${prefix}${chalk.gray(lineNumStr)} | ${formattedLine}`);
      }
    }
  }
}
