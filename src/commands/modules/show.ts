import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { ModuleWithMembers } from '../../db/database.js';
import {
  SharedFlags,
  collectFeaturesForFlows,
  collectFlowsForInteractions,
  outputJsonOrPlain,
  tableSeparator,
  withDatabase,
} from '../_shared/index.js';

export default class ModulesShow extends Command {
  static override description = 'Show module details including members';

  static override examples = [
    '<%= config.bin %> modules show auth',
    '<%= config.bin %> modules show project.backend.services --json',
    '<%= config.bin %> modules show database -d ./my-index.db',
  ];

  static override args = {
    name: Args.string({ description: 'Module name or path to show', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesShow);

    await withDatabase(flags.database, this, async (db) => {
      const allModules = db.modules.getAllWithMembers();

      // Try exact match on full path first
      let module = allModules.find((m) => m.fullPath === args.name);

      // Try exact match on name
      if (!module) {
        module = allModules.find((m) => m.name === args.name);
      }

      if (!module) {
        // Try partial match on path or name
        const matches = allModules.filter(
          (m) =>
            m.fullPath.toLowerCase().includes(args.name.toLowerCase()) ||
            m.name.toLowerCase().includes(args.name.toLowerCase())
        );

        if (matches.length === 1) {
          return this.displayModule(db, matches[0], flags.json);
        }
        if (matches.length > 1) {
          this.log(chalk.yellow(`Multiple modules match "${args.name}":`));
          for (const m of matches) {
            this.log(`  ${chalk.cyan(m.fullPath)} (${m.members.length} members)`);
          }
          this.log('');
          this.log(chalk.gray('Please specify the exact module path.'));
          return;
        }

        this.error(chalk.red(`Module "${args.name}" not found.`));
      }

      return this.displayModule(db, module, flags.json);
    });
  }

  private displayModule(
    db: import('../../db/database-facade.js').IndexDatabase,
    module: ModuleWithMembers,
    json: boolean
  ): void {
    // Get parent module
    const parent = module.parentId ? db.modules.getById(module.parentId) : null;

    // Get children
    const children = db.modules.getChildren(module.id);

    // Get interactions
    const outgoingInteractions = db.interactions.getFromModule(module.id);
    const incomingInteractions = db.interactions.getToModule(module.id);

    // Collect flows from all interactions (deduplicated)
    const allInteractionIds = [...outgoingInteractions.map((i) => i.id), ...incomingInteractions.map((i) => i.id)];
    const flows = collectFlowsForInteractions(allInteractionIds, db);

    // Collect features from all flows (deduplicated)
    const features = collectFeaturesForFlows(flows, db);

    const jsonData = {
      id: module.id,
      parentId: module.parentId,
      slug: module.slug,
      fullPath: module.fullPath,
      name: module.name,
      description: module.description,
      depth: module.depth,
      parent: parent ? { id: parent.id, name: parent.name, fullPath: parent.fullPath } : null,
      children: children.map((c) => ({ id: c.id, name: c.name, fullPath: c.fullPath, description: c.description })),
      outgoingInteractions: outgoingInteractions.map((i) => ({
        id: i.id,
        toModulePath: i.toModulePath,
        pattern: i.pattern,
        semantic: i.semantic,
        weight: i.weight,
      })),
      incomingInteractions: incomingInteractions.map((i) => ({
        id: i.id,
        fromModulePath: i.fromModulePath,
        pattern: i.pattern,
        semantic: i.semantic,
        weight: i.weight,
      })),
      flows: flows.map((f) => ({ id: f.id, name: f.name, slug: f.slug, stakeholder: f.stakeholder })),
      features,
      memberCount: module.members.length,
      members: module.members.map((m) => ({
        id: m.definitionId,
        name: m.name,
        kind: m.kind,
        filePath: m.filePath,
        line: m.line,
      })),
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      this.log(`Module: ${chalk.cyan(module.name)}`);
      this.log(`Path: ${chalk.gray(module.fullPath)}`);
      if (module.description) {
        this.log(`Description: ${module.description}`);
      }

      if (parent) {
        this.log(`Parent: ${chalk.cyan(parent.name)} ${chalk.gray(`(${parent.fullPath})`)}`);
      }

      // Children
      if (children.length > 0) {
        this.log('');
        this.log(chalk.bold(`Children (${children.length})`));
        for (const c of children) {
          const desc = c.description ? chalk.gray(` - ${c.description}`) : '';
          this.log(`  ${chalk.cyan(c.name)} ${chalk.gray(`(${c.fullPath})`)}${desc}`);
        }
      }

      // Outgoing interactions
      if (outgoingInteractions.length > 0) {
        this.log('');
        this.log(chalk.bold(`Outgoing Interactions (${outgoingInteractions.length})`));
        for (const i of outgoingInteractions) {
          const pattern = i.pattern ? ` [${i.pattern}]` : '';
          const semantic = i.semantic ? ` "${i.semantic}"` : '';
          this.log(`  -> ${chalk.cyan(i.toModulePath)}${pattern}${chalk.gray(semantic)} (${i.weight} calls)`);
        }
      }

      // Incoming interactions
      if (incomingInteractions.length > 0) {
        this.log('');
        this.log(chalk.bold(`Incoming Interactions (${incomingInteractions.length})`));
        for (const i of incomingInteractions) {
          const pattern = i.pattern ? ` [${i.pattern}]` : '';
          const semantic = i.semantic ? ` "${i.semantic}"` : '';
          this.log(`  <- ${chalk.cyan(i.fromModulePath)}${pattern}${chalk.gray(semantic)} (${i.weight} calls)`);
        }
      }

      // Flows
      if (flows.length > 0) {
        this.log('');
        this.log(chalk.bold(`Flows (${flows.length})`));
        for (const f of flows) {
          const stakeholder = f.stakeholder ? chalk.gray(` [${f.stakeholder}]`) : '';
          this.log(`  ${chalk.cyan(f.name)} (${f.slug})${stakeholder}`);
        }
      }

      // Features
      if (features.length > 0) {
        this.log('');
        this.log(chalk.bold(`Features (${features.length})`));
        for (const f of features) {
          this.log(`  ${chalk.cyan(f.name)} (${f.slug})`);
        }
      }

      // Members
      this.log('');
      this.log(`Members (${chalk.cyan(String(module.members.length))}):`);

      if (module.members.length === 0) {
        this.log(chalk.gray('  No members assigned to this module.'));
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(20, ...module.members.map((m) => m.name.length));
      const kindWidth = 12;

      this.log('');
      this.log(
        `  ${chalk.gray('Name'.padEnd(nameWidth))}  ${chalk.gray('Kind'.padEnd(kindWidth))}  ${chalk.gray('Location')}`
      );
      this.log(`  ${tableSeparator(nameWidth + kindWidth + 50)}`);

      for (const m of module.members) {
        const name = m.name.padEnd(nameWidth);
        const kind = m.kind.padEnd(kindWidth);
        const shortPath = m.filePath.length > 45 ? `...${m.filePath.slice(-42)}` : m.filePath;
        const location = `${shortPath}:${m.line}`;

        this.log(`  ${chalk.cyan(name)}  ${chalk.yellow(kind)}  ${chalk.gray(location)}`);
      }
    });
  }
}
