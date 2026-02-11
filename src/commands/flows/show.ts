import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import type { Flow } from '../../db/schema.js';
import {
  SharedFlags,
  collectModuleIdsFromSteps,
  outputJsonOrPlain,
  resolveModuleIds,
  withDatabase,
} from '../_shared/index.js';

export default class FlowsShow extends Command {
  static override description = 'Show flow details with interaction steps';

  static override examples = [
    '<%= config.bin %> flows show login-flow',
    '<%= config.bin %> flows show 5',
    '<%= config.bin %> flows show user-registration --json',
  ];

  static override args = {
    identifier: Args.string({ description: 'Flow name, slug, or ID', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsShow);

    await withDatabase(flags.database, this, async (db) => {
      const flow = this.findFlow(db, args.identifier);

      if (!flow) {
        // Try partial match
        const allFlows = db.flows.getAll();
        const matches = allFlows.filter(
          (f) =>
            f.name.toLowerCase().includes(args.identifier.toLowerCase()) ||
            f.slug.toLowerCase().includes(args.identifier.toLowerCase())
        );

        if (matches.length === 1) {
          this.displayFlow(db, matches[0], flags.json);
          return;
        }
        if (matches.length > 1) {
          if (flags.json) {
            this.log(
              JSON.stringify({
                error: 'Multiple matches',
                matches: matches.map((f) => ({ id: f.id, name: f.name, slug: f.slug })),
              })
            );
          } else {
            this.log(chalk.yellow(`Multiple flows match "${args.identifier}":`));
            for (const f of matches) {
              this.log(`  ${chalk.cyan(f.name)} ${chalk.gray(`(${f.slug})`)}`);
            }
            this.log('');
            this.log(chalk.gray('Please specify the exact slug or ID.'));
          }
          return;
        }

        if (flags.json) {
          this.log(JSON.stringify({ error: `Flow "${args.identifier}" not found.` }));
        } else {
          this.log(chalk.red(`Flow "${args.identifier}" not found.`));
        }
        return;
      }

      this.displayFlow(db, flow, flags.json);
    });
  }

  private findFlow(db: IndexDatabase, identifier: string): Flow | null {
    // Try by ID
    const id = Number.parseInt(identifier, 10);
    if (!Number.isNaN(id)) {
      const flow = db.flows.getById(id);
      if (flow) return flow;
    }

    // Try by slug
    const bySlug = db.flows.getBySlug(identifier);
    if (bySlug) return bySlug;

    // Try exact name match
    const allFlows = db.flows.getAll();
    const byName = allFlows.find((f) => f.name === identifier);
    return byName ?? null;
  }

  private displayFlow(db: IndexDatabase, flow: Flow, isJson: boolean): void {
    // Get flow with steps
    const flowWithSteps = db.flows.getWithSteps(flow.id);

    // Get features for this flow
    const features = db.features.getFeaturesForFlow(flow.id);

    // Get entry point details
    let entryPoint: {
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      metadata: Record<string, string>;
    } | null = null;
    if (flow.entryPointId) {
      const entryDef = db.definitions.getById(flow.entryPointId);
      if (entryDef) {
        const entryMeta = db.metadata.get(flow.entryPointId);
        entryPoint = {
          id: entryDef.id,
          name: entryDef.name,
          kind: entryDef.kind,
          filePath: entryDef.filePath,
          line: entryDef.line,
          metadata: entryMeta,
        };
      }
    }

    // Collect unique modules involved from steps
    const moduleIdSet = flowWithSteps ? collectModuleIdsFromSteps(flowWithSteps.steps) : new Set<number>();
    const modulesInvolved = resolveModuleIds(moduleIdSet, db);

    // Get definition steps
    const flowWithDefSteps = db.flows.getWithDefinitionSteps(flow.id);
    const definitionSteps = flowWithDefSteps?.definitionSteps ?? [];

    const jsonData = {
      ...flowWithSteps,
      features: features.map((f) => ({ id: f.id, name: f.name, slug: f.slug })),
      entryPoint,
      modulesInvolved,
      definitionSteps,
    };

    outputJsonOrPlain(this, isJson, jsonData, () => {
      // Flow header
      this.log(chalk.bold(`Flow: ${flow.name}`));
      this.log(`Slug: ${chalk.gray(flow.slug)}`);
      if (flow.stakeholder) {
        this.log(`Stakeholder: ${this.getStakeholderDisplay(flow.stakeholder)}`);
      }
      if (flow.entryPath) {
        this.log(`Entry: ${flow.entryPath}`);
      }
      if (flow.description) {
        this.log(`Description: ${flow.description}`);
      }

      // Features
      if (features.length > 0) {
        for (const f of features) {
          this.log(`Feature: ${chalk.cyan(f.name)} (${f.slug})`);
        }
      }

      // Entry point details
      if (entryPoint) {
        this.log('');
        this.log(chalk.bold('Entry Point'));
        this.log(
          `  ${chalk.cyan(entryPoint.name)} (${entryPoint.kind}) ${chalk.gray(`${entryPoint.filePath}:${entryPoint.line}`)}`
        );
        if (entryPoint.metadata.purpose) {
          this.log(`  Purpose: ${chalk.gray(entryPoint.metadata.purpose)}`);
        }
      }

      // Modules involved
      if (modulesInvolved.length > 0) {
        this.log('');
        this.log(chalk.bold(`Modules Involved (${modulesInvolved.length})`));
        for (const m of modulesInvolved) {
          this.log(`  ${chalk.cyan(m.name)} ${chalk.gray(`(${m.fullPath})`)}`);
        }
      }

      // Steps
      if (flowWithSteps && flowWithSteps.steps.length > 0) {
        this.log('');
        this.log(chalk.bold(`Steps (${flowWithSteps.steps.length})`));

        for (const step of flowWithSteps.steps) {
          const i = step.interaction;
          const fromShort = i.fromModulePath.split('.').slice(-2).join('.');
          const toShort = i.toModulePath.split('.').slice(-2).join('.');
          const patternLabel =
            i.pattern === 'business'
              ? chalk.cyan('[business]')
              : i.pattern === 'utility'
                ? chalk.yellow('[utility]')
                : '';

          this.log(`  ${step.stepOrder}. ${fromShort} → ${toShort} ${patternLabel}`);
          if (i.semantic) {
            this.log(`     ${chalk.gray(`"${i.semantic}"`)}`);
          }
        }
      } else {
        this.log('');
        this.log(chalk.gray('No steps recorded for this flow.'));
      }

      // Definition trace
      if (definitionSteps.length > 0) {
        this.log('');
        this.log(chalk.bold(`Definition Trace (${definitionSteps.length})`));
        for (const ds of definitionSteps) {
          const fromFile = ds.fromFilePath ? chalk.gray(`${ds.fromFilePath}:${ds.fromLine}`) : '';
          const toFile = ds.toFilePath ? chalk.gray(`${ds.toFilePath}:${ds.toLine}`) : '';
          this.log(
            `  ${ds.stepOrder}. ${chalk.cyan(ds.fromDefinitionName ?? '?')}() -> ${chalk.cyan(ds.toDefinitionName ?? '?')}()  ${fromFile} -> ${toFile}`
          );
        }
      }
    });
  }

  private getStakeholderDisplay(stakeholder: string): string {
    const colors: Record<string, (s: string) => string> = {
      user: chalk.green,
      admin: chalk.red,
      system: chalk.blue,
      developer: chalk.yellow,
      external: chalk.magenta,
    };
    const colorFn = colors[stakeholder] ?? chalk.white;
    return colorFn(stakeholder);
  }
}
