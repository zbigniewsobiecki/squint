import path from 'node:path';
import { Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database-facade.js';
import { LlmFlags, SharedFlags, readAllLines } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { extractCsvContent, parseRow, splitCsvLines } from '../llm/_shared/csv-utils.js';
import { completeWithLogging, getErrorMessage } from '../llm/_shared/llm-utils.js';
import { computeProcessGroups, getProcessGroupLabel } from '../llm/_shared/process-utils.js';

/**
 * Boundary role patterns for candidate detection.
 */
const BOUNDARY_ROLE_PATTERNS = new Set([
  'controller',
  'handler',
  'route-handler',
  'api-client',
  'service-client',
  'hook',
  'middleware',
  'router',
  'gateway',
  'adapter',
  'proxy',
  'consumer',
  'producer',
  'listener',
  'emitter',
  'subscriber',
  'publisher',
]);

const BOUNDARY_NAME_PATTERNS =
  /\b(send|emit|publish|subscribe|listen|consume|produce|handle|dispatch|broadcast|notify|enqueue|dequeue|fetch)\b/i;

const BOUNDARY_PATH_PATTERNS =
  /\b(router|controller|handler|hook|client|endpoint|api|gateway|service|provider|adapter|facade|proxy|middleware)\b/i;

interface ContractEntry {
  protocol: string;
  role: string;
  key: string;
  normalizedKey?: string;
  details?: string;
}

interface CandidateDefinition {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine: number;
  moduleId: number | null;
  role: string | null;
}

/**
 * Trivial sanitization for normalized keys (LLM-driven normalization).
 */
function sanitizeNormalizedKey(key: string): string {
  return key.trim();
}

export default class ContractsExtract extends BaseLlmCommand {
  static override description = 'Extract boundary communication contracts from definitions using LLM analysis';

  static override examples = [
    '<%= config.bin %> contracts extract',
    '<%= config.bin %> contracts extract --force',
    '<%= config.bin %> contracts extract -d index.db --verbose',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    'batch-size': Flags.integer({
      description: 'Definitions per LLM batch',
      default: 10,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, verbose, model } = ctx;
    const batchSize = flags['batch-size'] as number;

    // Check if contracts already exist
    const existingCount = db.contracts.getCount();
    if (
      !this.checkExistingAndClear(ctx, {
        entityName: 'Contracts',
        existingCount,
        force: flags.force as boolean,
        clearFn: () => db.contracts.clear(),
        forceHint: 'Use --force to re-extract',
      })
    ) {
      return;
    }

    this.logHeader(ctx, 'Contract Extraction');

    // Step 1: Select candidate definitions
    const candidates = this.selectCandidates(db);

    if (candidates.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ contracts: 0, participants: 0 }));
      } else {
        this.log(chalk.yellow('No boundary candidate definitions found.'));
      }
      return;
    }

    if (!isJson) {
      this.log(`Found ${candidates.length} candidate boundary definitions`);
    }

    // Group by directory so related files are batched together
    candidates.sort((a, b) => {
      const dirA = path.dirname(a.filePath);
      const dirB = path.dirname(b.filePath);
      if (dirA !== dirB) return dirA.localeCompare(dirB);
      return a.filePath.localeCompare(b.filePath);
    });

    // Step 2: Process in batches via LLM
    let totalContracts = 0;
    let totalParticipants = 0;
    const protocolCounts = new Map<string, number>();

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchIdx = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(candidates.length / batchSize);

      try {
        const results = await this.extractBatch(batch, db, model, isJson, batchIdx, totalBatches);

        if (!dryRun) {
          for (const { definitionId, moduleId, contracts } of results) {
            for (const entry of contracts) {
              const normalizedKey = sanitizeNormalizedKey(entry.normalizedKey ?? entry.key);
              const contractId = db.contracts.upsertContract(entry.protocol, entry.key, normalizedKey, entry.details);
              db.contracts.addParticipant(contractId, definitionId, moduleId, entry.role);
              totalParticipants++;

              // Track protocol counts
              protocolCounts.set(entry.protocol, (protocolCounts.get(entry.protocol) ?? 0) + 1);
            }

            // Also store raw JSON as definition_metadata for annotation pipeline compatibility
            db.metadata.set(definitionId, 'contracts', JSON.stringify(contracts));
          }

          // Count distinct contracts
          totalContracts = db.contracts.getCount();
        }

        if (!isJson && verbose) {
          this.log(chalk.gray(`  Batch ${batchIdx}/${totalBatches}: ${results.length} definitions with contracts`));
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (!isJson) {
          this.log(chalk.yellow(`  Batch ${batchIdx}/${totalBatches} failed: ${message}`));
        }
      }
    }

    // Backfill any NULL module_ids (safety net for standalone runs)
    if (!dryRun) {
      const backfilled = db.contracts.backfillModuleIds();
      if (backfilled > 0 && !isJson && verbose) {
        this.log(chalk.gray(`  Backfilled ${backfilled} participant module_id(s)`));
      }
    }

    // Step 3: Report
    if (isJson) {
      this.log(
        JSON.stringify({
          contracts: totalContracts,
          participants: totalParticipants,
          protocols: Object.fromEntries(protocolCounts),
        })
      );
    } else {
      this.log('');
      this.log(chalk.bold('Results'));
      this.log(`Contracts: ${totalContracts}`);
      this.log(`Participants: ${totalParticipants}`);
      if (protocolCounts.size > 0) {
        this.log('Protocol breakdown:');
        for (const [protocol, count] of [...protocolCounts.entries()].sort((a, b) => b[1] - a[1])) {
          this.log(`  ${protocol}: ${count}`);
        }
      }

      // Show matched vs unmatched
      const matched = db.contracts.getMatchedContracts();
      const unmatched = db.contracts.getUnmatchedContracts();
      if (matched.length > 0 || unmatched.length > 0) {
        this.log(`Matched (both sides): ${matched.length}`);
        this.log(`Unmatched (one-sided): ${unmatched.length}`);
      }

      // Show process group topology
      const processGroups = computeProcessGroups(db);
      if (processGroups.groupCount >= 2) {
        const moduleToGroup = new Map<number, string>();
        for (const [, mods] of processGroups.groupToModules) {
          const label = getProcessGroupLabel(mods);
          for (const m of mods) {
            moduleToGroup.set(m.id, label);
          }
        }
        const topology = db.contracts.getTopologyBetweenGroups(moduleToGroup);
        if (topology.length > 0) {
          this.log('');
          this.log(chalk.bold('Communication Topology'));
          for (const edge of topology) {
            this.log(
              `  ${edge.fromGroupLabel} ↔ ${edge.toGroupLabel}: ${edge.contractCount} contracts (${edge.protocols.join(', ')})`
            );
          }
        }
      }

      if (dryRun) {
        this.log('');
        this.log(chalk.gray('(Dry run - no changes persisted)'));
      }
    }
  }

  /**
   * Select candidate definitions that are likely boundary communication participants.
   */
  private selectCandidates(db: IndexDatabase): CandidateDefinition[] {
    // Get all definitions with their metadata and module assignments
    const rows = db
      .getConnection()
      .prepare(`
      SELECT
        d.id, d.name, d.kind, f.path as filePath, d.line, d.end_line as endLine,
        mm.module_id as moduleId,
        dm_role.value as role
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      LEFT JOIN module_members mm ON mm.definition_id = d.id
      LEFT JOIN definition_metadata dm_role ON dm_role.definition_id = d.id AND dm_role.key = 'role'
      WHERE d.kind IN ('function', 'class', 'variable', 'method', 'const')
    `)
      .all() as CandidateDefinition[];

    return rows.filter((def) => {
      // Criterion 1: Role metadata matches boundary patterns
      if (def.role && BOUNDARY_ROLE_PATTERNS.has(def.role.toLowerCase())) {
        return true;
      }

      // Criterion 2: Module path matches boundary patterns
      if (BOUNDARY_PATH_PATTERNS.test(def.filePath)) {
        return true;
      }

      // Criterion 3: Name contains boundary verbs
      if (BOUNDARY_NAME_PATTERNS.test(def.name)) {
        return true;
      }

      return false;
    });
  }

  /**
   * Extract contracts from a batch of candidate definitions via LLM.
   */
  private async extractBatch(
    candidates: CandidateDefinition[],
    db: IndexDatabase,
    model: string,
    isJson: boolean,
    batchIdx: number,
    totalBatches: number
  ): Promise<Array<{ definitionId: number; moduleId: number | null; contracts: ContractEntry[] }>> {
    const systemPrompt = `You extract boundary communication contracts from code definitions.
A contract is any cross-process communication channel — HTTP, WebSocket, gRPC, message queues, pub/sub, events, file I/O, email, CLI invocation, IPC, or any other runtime protocol.

For each definition, identify if it participates in any communication contracts.

Output CSV with columns: definition_id,contracts_json
- contracts_json is a JSON array, or "null" if no contracts.
- Each contract: {"protocol":"...","role":"...","key":"...","normalizedKey":"..."}
- protocol: free-form string (http, ws, grpc, queue, pubsub, event, email, file, ipc, cli, etc.)
- role: server/client, producer/consumer, emitter/listener, publisher/subscriber, sender/receiver, writer/reader
- key: literal identifier from code (e.g., "/api/vehicles/:id", "vehicle:updated")
- normalizedKey: canonical form identical on BOTH sides of the same channel. Strip variable segments, normalize casing.
  Examples: "GET /api/vehicles/:id" → "GET /api/vehicles/{param}", "/api/vehicles" → "GET /api/vehicles" (include HTTP method)

\`\`\`csv
definition_id,contracts_json
42,"[{""protocol"":""http"",""role"":""server"",""key"":""GET /api/vehicles"",""normalizedKey"":""GET /api/vehicles""}]"
55,"[{""protocol"":""queue"",""role"":""producer"",""key"":""order-processing"",""normalizedKey"":""order-processing""}]"
88,"null"
\`\`\`

Rules:
- Only report contracts for actual cross-process communication (not internal function calls)
- Include the HTTP method in the key/normalizedKey for HTTP contracts
- For REST routes with dynamic params, normalize: /vehicles/:id → /vehicles/{param}
- For WebSocket/event names, normalize casing: "Vehicle:Updated" → "vehicle:updated"
- If a definition handles MULTIPLE endpoints, list each as a separate contract entry
- For HTTP clients using a base URL (e.g., axios baseURL, fetch with base path), combine the base URL path with the relative endpoint path in normalizedKey. Example: baseURL='/api' + get('/vehicles') → normalizedKey='GET /api/vehicles'
- normalizedKey must represent the FULL server-side path, not the relative client-side path
- When you see both a server route definition and a client API call in the same batch, ensure their normalizedKeys are identical`;

    // Build user prompt with source code — group by file for deduplication
    const parts: string[] = [];
    parts.push(`## Definitions to Analyze (${candidates.length})`);
    parts.push('');

    const fileGroups = new Map<string, CandidateDefinition[]>();
    for (const def of candidates) {
      const existing = fileGroups.get(def.filePath) ?? [];
      existing.push(def);
      fileGroups.set(def.filePath, existing);
    }

    for (const [filePath, defs] of fileGroups) {
      const resolvedPath = db.resolveFilePath(filePath);
      const allLines = await readAllLines(resolvedPath);
      const fullSource = allLines.join('\n');

      parts.push(`### File: ${filePath}`);
      parts.push('```typescript');
      parts.push(fullSource);
      parts.push('```');
      parts.push('');
      parts.push('Definitions in this file:');
      for (const def of defs) {
        parts.push(
          `- #${def.id}: ${def.name} (${def.kind}, lines ${def.line}-${def.endLine})${def.role ? ` [role: ${def.role}]` : ''}`
        );
      }
      parts.push('');
    }

    parts.push('Extract communication contracts in CSV format.');

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt: parts.join('\n'),
      temperature: 0,
      maxTokens: 4096,
      command: this,
      isJson,
      iteration: { current: batchIdx, max: totalBatches },
    });

    return this.parseExtractResponse(response, candidates);
  }

  /**
   * Parse the LLM response into contract entries per definition.
   */
  private parseExtractResponse(
    response: string,
    candidates: CandidateDefinition[]
  ): Array<{ definitionId: number; moduleId: number | null; contracts: ContractEntry[] }> {
    const results: Array<{ definitionId: number; moduleId: number | null; contracts: ContractEntry[] }> = [];
    const candidateMap = new Map(candidates.map((c) => [c.id, c]));

    const csv = extractCsvContent(response);
    const lines = splitCsvLines(csv);

    for (const line of lines) {
      if (!line.trim() || line.startsWith('definition_id')) continue;

      const fields = parseRow(line);
      if (!fields || fields.length < 2) continue;

      const [idStr, contractsJson] = fields;
      const defId = Number.parseInt(idStr.trim(), 10);
      if (Number.isNaN(defId)) continue;

      const candidate = candidateMap.get(defId);
      if (!candidate) continue;

      if (contractsJson.trim() === 'null' || contractsJson.trim() === '') continue;

      try {
        const parsed = JSON.parse(contractsJson);
        if (!Array.isArray(parsed)) continue;

        const validContracts: ContractEntry[] = [];
        for (const entry of parsed) {
          if (!entry.protocol || !entry.role || !entry.key) continue;
          validContracts.push({
            protocol: entry.protocol.trim().toLowerCase(),
            role: entry.role.trim().toLowerCase(),
            key: entry.key.trim(),
            normalizedKey: entry.normalizedKey?.trim() ?? entry.key.trim(),
            details: entry.details?.trim(),
          });
        }

        if (validContracts.length > 0) {
          results.push({
            definitionId: defId,
            moduleId: candidate.moduleId,
            contracts: validContracts,
          });
        }
      } catch {
        // Skip malformed JSON
      }
    }

    return results;
  }
}
