import path from 'node:path';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import type { InteractionWithPaths, ModuleTreeNode } from '../db/schema.js';
import { SharedFlags, outputJsonOrPlain, withDatabase } from './_shared/index.js';

// ============================================================
// Compact File Tree
// ============================================================

interface DirNode {
  name: string;
  children: Map<string, DirNode>;
  files: string[];
}

function buildTrie(paths: string[]): DirNode {
  const root: DirNode = { name: '', children: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    const fileName = parts.pop()!;
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), files: [] });
      }
      node = node.children.get(part)!;
    }
    node.files.push(fileName);
  }
  return root;
}

function collapseTrie(node: DirNode): DirNode {
  // Recursively collapse children first
  const collapsed = new Map<string, DirNode>();
  for (const [key, child] of node.children) {
    collapsed.set(key, collapseTrie(child));
  }
  node.children = collapsed;

  // If this node has exactly one child dir and zero files, merge
  if (node.children.size === 1 && node.files.length === 0) {
    const [childKey, child] = [...node.children.entries()][0];
    const mergedName = node.name ? `${node.name}/${childKey}` : childKey;
    child.name = mergedName;
    return child;
  }

  return node;
}

function renderFileTree(node: DirNode, indent: string, lines: string[]): void {
  let currentIndent = indent;
  // Sort children and files
  const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sortedFiles = [...node.files].sort();

  // Print directory header
  if (node.name) {
    lines.push(`${currentIndent}${node.name}/`);
    currentIndent += '  ';
  }

  // Print files on comma-separated lines, wrapping at 80 chars
  if (sortedFiles.length > 0) {
    let line = currentIndent;
    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const suffix = i < sortedFiles.length - 1 ? ', ' : '';
      if (line.length + file.length + suffix.length > 80 && line.length > currentIndent.length) {
        lines.push(line.replace(/,\s*$/, ','));
        line = currentIndent + file + suffix;
      } else {
        line += file + suffix;
      }
    }
    if (line.length > currentIndent.length) {
      lines.push(line);
    }
  }

  // Recurse into subdirectories
  for (const child of sortedChildren) {
    renderFileTree(child, currentIndent, lines);
  }
}

// ============================================================
// Module Tree with Interactions
// ============================================================

interface ModuleJsonNode {
  slug: string;
  fullPath: string;
  name: string;
  description: string | null;
  isTest: boolean;
  interactions: Array<{ targetPath: string; semantic: string }>;
  children: ModuleJsonNode[];
}

function buildModuleJson(
  node: ModuleTreeNode,
  interactionsByModule: Map<number, InteractionWithPaths[]>
): ModuleJsonNode {
  const ixList = interactionsByModule.get(node.id) ?? [];
  return {
    slug: node.slug,
    fullPath: node.fullPath,
    name: node.name,
    description: node.description,
    isTest: node.isTest,
    interactions: ixList.map((ix) => ({
      targetPath: ix.toModulePath.split('.').slice(1).join('.'),
      semantic: ix.semantic ?? '',
    })),
    children: node.children.map((c) => buildModuleJson(c, interactionsByModule)),
  };
}

// ============================================================
// Command
// ============================================================

export default class Overview extends Command {
  static override description = 'Show a complete codebase overview: stats, features, module tree, and file tree';

  static override examples = [
    '<%= config.bin %> overview',
    '<%= config.bin %> overview -d ./my-index.db',
    '<%= config.bin %> overview --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Overview);

    await withDatabase(flags.database, this, async (db) => {
      const sourceDir = db.getSourceDirectory();
      const projectName = path.basename(sourceDir);

      // ── Stats ──
      const fileCount = db.files.getCount();
      const defCount = db.definitions.getCount();
      const moduleStats = db.modules.getStats();
      const interactionCount = db.interactions.getCount();
      const flowCount = db.flows.getCount();
      const featureCount = db.features.getCount();

      // ── Features with flows ──
      const features = db.features.getAll();
      const featuresWithFlows = features.map((f) => {
        const withFlows = db.features.getWithFlows(f.id);
        return { ...f, flows: withFlows?.flows ?? [] };
      });

      // ── Module tree + interactions ──
      const moduleTree = db.modules.getTree();
      const allInteractions = db.interactions.getAll();
      const interactionsByModule = new Map<number, InteractionWithPaths[]>();
      for (const ix of allInteractions) {
        const list = interactionsByModule.get(ix.fromModuleId) ?? [];
        list.push(ix);
        interactionsByModule.set(ix.fromModuleId, list);
      }

      // ── Files ──
      const allFiles = db.files.getAll();
      const filePaths = allFiles.map((f) => f.path);

      // ── Output ──
      outputJsonOrPlain(
        this,
        flags.json,
        {
          sourceDirectory: sourceDir,
          stats: {
            files: fileCount,
            definitions: defCount,
            modules: moduleStats.moduleCount,
            interactions: interactionCount,
            flows: flowCount,
            features: featureCount,
          },
          features: featuresWithFlows.map((f) => ({
            name: f.name,
            slug: f.slug,
            description: f.description,
            flows: f.flows.map((fl) => ({
              name: fl.name,
              slug: fl.slug,
              stakeholder: fl.stakeholder,
              description: fl.description,
            })),
          })),
          moduleTree: moduleTree ? buildModuleJson(moduleTree, interactionsByModule) : null,
          files: filePaths,
        },
        () => {
          // ── Header ──
          this.log(chalk.bold(`# Overview: ${projectName}`));
          this.log('');

          // ── Stats ──
          this.log(chalk.bold('## Stats'));
          this.log(
            `${fileCount} files, ${defCount} definitions, ${moduleStats.moduleCount} modules, ${interactionCount} interactions, ${flowCount} flows, ${featureCount} features`
          );
          this.log('');

          // ── Features ──
          if (featuresWithFlows.length > 0) {
            this.log(chalk.bold('## Features'));
            this.log('');
            for (const f of featuresWithFlows) {
              this.log(chalk.bold(`### ${f.name}`));
              if (f.description) {
                this.log(f.description);
              }
              for (const fl of f.flows) {
                const desc = fl.description ? ` — ${fl.description}` : '';
                this.log(`  - ${fl.name}${desc}`);
              }
              this.log('');
            }
          }

          // ── Module Tree ──
          if (moduleTree) {
            this.log(chalk.bold('## Module Tree'));
            this.log('');
            this.printModuleTree(moduleTree, '', true, interactionsByModule);
            this.log('');
          }

          // ── File Tree ──
          if (filePaths.length > 0) {
            this.log(chalk.bold('## Files'));
            this.log('');
            const trie = buildTrie(filePaths);
            const collapsed = collapseTrie(trie);
            const lines: string[] = [];
            renderFileTree(collapsed, '', lines);
            for (const line of lines) {
              this.log(line);
            }
          }
        }
      );
    });
  }

  private printModuleTree(
    node: ModuleTreeNode,
    prefix: string,
    isLast: boolean,
    interactionsByModule: Map<number, InteractionWithPaths[]>
  ): void {
    const connector = isLast ? '└── ' : '├── ';
    const nameStr = chalk.cyan(node.name);
    const desc = node.description ? ` — ${node.description}` : '';
    const testSuffix = node.isTest ? chalk.gray(' [test]') : '';
    this.log(`${prefix}${connector}${nameStr}${desc}${testSuffix}`);

    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    // Print outgoing interactions for this module
    const ixList = interactionsByModule.get(node.id) ?? [];
    for (const ix of ixList) {
      const targetPath = ix.toModulePath.split('.').slice(1).join('.');
      const semantic = ix.semantic ? `: ${ix.semantic}` : '';
      this.log(`${childPrefix}${chalk.yellow('→')} ${targetPath}${semantic}`);
    }

    // Recurse into children
    for (let i = 0; i < node.children.length; i++) {
      this.printModuleTree(node.children[i], childPrefix, i === node.children.length - 1, interactionsByModule);
    }
  }
}
