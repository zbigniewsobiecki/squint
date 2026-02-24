import type { IndexDatabase } from '../../../db/database-facade.js';
import type { ContractParticipant, ContractWithParticipants } from '../../../db/schema.js';
import { stripApiPrefix } from '../../contracts/_shared/key-resolver.js';
import type { ProcessGroups } from '../../llm/_shared/process-utils.js';

/**
 * Complementary role pairs — two participants match when they have
 * the same (protocol, normalizedKey) but complementary roles.
 */
const ROLE_COMPLEMENTS: Record<string, string> = {
  server: 'client',
  client: 'server',
  producer: 'consumer',
  consumer: 'producer',
  emitter: 'listener',
  listener: 'emitter',
  publisher: 'subscriber',
  subscriber: 'publisher',
  sender: 'receiver',
  receiver: 'sender',
  writer: 'reader',
  reader: 'writer',
};

/**
 * Which roles are the "initiator" (from-side in interaction direction)?
 * The initiator calls/requests/consumes — the other side handles/serves/provides.
 */
const INITIATOR_ROLES = new Set(['client', 'consumer', 'listener', 'subscriber', 'receiver', 'reader']);

export interface ContractMatch {
  contractId: number;
  protocol: string;
  key: string;
  normalizedKey: string;
  /** The participant that initiates (from-side) */
  initiator: ContractParticipant;
  /** The participant that handles (to-side) */
  handler: ContractParticipant;
  /** Module ID of the initiator */
  fromModuleId: number;
  /** Module ID of the handler */
  toModuleId: number;
}

export interface MatchStats {
  matched: number;
  unmatched: number;
  byProtocol: Map<string, number>;
}

export interface MaterializeResult {
  created: number;
  linked: number;
}

/**
 * Build a fuzzy key from a normalizedKey by stripping the HTTP method prefix
 * and common API path prefixes.
 * e.g., "GET /api/v1/vehicles/{param}" → "GET /vehicles/{param}"
 */
function fuzzyKey(normalizedKey: string): string {
  const httpMatch = normalizedKey.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i);
  if (httpMatch) {
    return `${httpMatch[1].toUpperCase()} ${stripApiPrefix(httpMatch[2])}`;
  }
  return stripApiPrefix(normalizedKey);
}

/**
 * Matches contracts with complementary-role participants in different process groups,
 * then materializes them into interactions with definition-level links.
 */
export class ContractMatcher {
  /**
   * Find all matched contracts — contracts where complementary roles exist
   * in different process groups.
   */
  match(db: IndexDatabase, processGroups: ProcessGroups): ContractMatch[] {
    const contractsWithParticipants = db.contracts.getAllWithParticipants();
    const results: ContractMatch[] = [];

    // Phase 1: exact within-contract matching
    const matchedContractIds = new Set<number>();
    for (const contract of contractsWithParticipants) {
      const matches = this.matchContract(contract, processGroups);
      if (matches.length > 0) {
        matchedContractIds.add(contract.id);
      }
      results.push(...matches);
    }

    // Phase 2: cross-contract fuzzy matching for unmatched contracts
    const unmatchedContracts = contractsWithParticipants.filter((c) => !matchedContractIds.has(c.id));
    const fuzzyMatches = this.fuzzyMatchAcrossContracts(unmatchedContracts, processGroups);
    results.push(...fuzzyMatches);

    return results;
  }

  /**
   * Get match statistics.
   */
  getStats(db: IndexDatabase, processGroups: ProcessGroups): MatchStats {
    const contractsWithParticipants = db.contracts.getAllWithParticipants();
    let matched = 0;
    let unmatched = 0;
    const byProtocol = new Map<string, number>();

    for (const contract of contractsWithParticipants) {
      const matches = this.matchContract(contract, processGroups);
      if (matches.length > 0) {
        matched++;
        byProtocol.set(contract.protocol, (byProtocol.get(contract.protocol) ?? 0) + 1);
      } else {
        unmatched++;
      }
    }

    return { matched, unmatched, byProtocol };
  }

  /**
   * Materialize matched contracts into interactions and definition links.
   * Returns the number of interactions created and definition links inserted.
   */
  materializeInteractions(db: IndexDatabase, matches: ContractMatch[]): MaterializeResult {
    let created = 0;
    let linked = 0;

    // Group matches by module pair for aggregation
    const pairMap = new Map<
      string,
      {
        fromModuleId: number;
        toModuleId: number;
        matches: ContractMatch[];
      }
    >();

    for (const match of matches) {
      const key = `${match.fromModuleId}->${match.toModuleId}`;
      const existing = pairMap.get(key);
      if (existing) {
        existing.matches.push(match);
      } else {
        pairMap.set(key, {
          fromModuleId: match.fromModuleId,
          toModuleId: match.toModuleId,
          matches: [match],
        });
      }
    }

    for (const [, pair] of pairMap) {
      // Build semantic description from matched contracts
      const protocolSummary = new Map<string, string[]>();
      for (const m of pair.matches) {
        const existing = protocolSummary.get(m.protocol) ?? [];
        existing.push(m.key);
        protocolSummary.set(m.protocol, existing);
      }

      const semanticParts: string[] = [];
      for (const [protocol, keys] of protocolSummary) {
        if (keys.length <= 3) {
          semanticParts.push(`${protocol}: ${keys.join(', ')}`);
        } else {
          semanticParts.push(`${protocol}: ${keys.slice(0, 3).join(', ')} (+${keys.length - 3} more)`);
        }
      }
      const semantic = semanticParts.join('; ');

      // Collect handler symbol names
      const handlerNames: string[] = [];
      for (const m of pair.matches) {
        // Get definition name from the handler participant
        const defRow = db
          .getConnection()
          .prepare('SELECT name FROM definitions WHERE id = ?')
          .get(m.handler.definitionId) as { name: string } | undefined;
        if (defRow) {
          handlerNames.push(defRow.name);
        }
      }
      const uniqueSymbols = [...new Set(handlerNames)].slice(0, 20);

      // Upsert interaction
      const interactionId = db.interactions.upsert(pair.fromModuleId, pair.toModuleId, {
        semantic,
        source: 'contract-matched',
        pattern: 'business',
        symbols: uniqueSymbols.length > 0 ? uniqueSymbols : undefined,
        weight: pair.matches.length,
        confidence: 'high',
      });
      created++;

      // Insert definition-level links
      for (const m of pair.matches) {
        db.interactions.insertDefinitionLink(
          interactionId,
          m.initiator.definitionId,
          m.handler.definitionId,
          m.contractId
        );
        linked++;
      }
    }

    return { created, linked };
  }

  /**
   * Match a single contract — find complementary role pairs in different process groups.
   */
  private matchContract(contract: ContractWithParticipants, _processGroups: ProcessGroups): ContractMatch[] {
    const results: ContractMatch[] = [];

    // Group participants by role
    const byRole = new Map<string, ContractParticipant[]>();
    for (const p of contract.participants) {
      const existing = byRole.get(p.role) ?? [];
      existing.push(p);
      byRole.set(p.role, existing);
    }

    // Find complementary pairs — only iterate from initiator roles to avoid
    // producing each (fromModule, toModule) pair twice.
    for (const [roleA, participantsA] of byRole) {
      if (!INITIATOR_ROLES.has(roleA)) continue;
      const complementRole = ROLE_COMPLEMENTS[roleA];
      if (!complementRole) continue;

      const participantsB = byRole.get(complementRole);
      if (!participantsB) continue;

      // Create pairs from complementary roles in different modules.
      // Contracts themselves are evidence of cross-process communication,
      // so we don't require different process groups — shared type packages
      // (e.g. monorepo barrel exports) can collapse separate processes into
      // one group in the import-based Union-Find.
      for (const pA of participantsA) {
        if (pA.moduleId === null) continue;

        for (const pB of participantsB) {
          if (pB.moduleId === null) continue;

          // Must be different modules (avoid self-match)
          if (pA.moduleId === pB.moduleId) continue;

          // Determine direction based on INITIATOR_ROLES
          const aIsInitiator = INITIATOR_ROLES.has(roleA);

          results.push({
            contractId: contract.id,
            protocol: contract.protocol,
            key: contract.key,
            normalizedKey: contract.normalizedKey,
            initiator: aIsInitiator ? pA : pB,
            handler: aIsInitiator ? pB : pA,
            fromModuleId: aIsInitiator ? pA.moduleId : pB.moduleId,
            toModuleId: aIsInitiator ? pB.moduleId : pA.moduleId,
          });
        }
      }
    }

    return results;
  }

  /**
   * Cross-contract fuzzy matching: find complementary-role participants on
   * _different_ contracts whose normalizedKeys become identical after stripping
   * common API prefixes (e.g. /api, /v1, /api/v1).
   */
  private fuzzyMatchAcrossContracts(
    contracts: ContractWithParticipants[],
    _processGroups: ProcessGroups
  ): ContractMatch[] {
    const results: ContractMatch[] = [];

    // Index participants by fuzzy key + protocol
    const byFuzzyKey = new Map<
      string,
      Array<{ contract: ContractWithParticipants; participant: ContractParticipant }>
    >();

    for (const contract of contracts) {
      const fKey = `${contract.protocol}:${fuzzyKey(contract.normalizedKey)}`;
      for (const participant of contract.participants) {
        if (participant.moduleId === null) continue;
        const list = byFuzzyKey.get(fKey) ?? [];
        list.push({ contract, participant });
        byFuzzyKey.set(fKey, list);
      }
    }

    // For each fuzzy key group, find complementary role pairs across contracts
    const matched = new Set<string>(); // deduplicate by "contractA:contractB:modA:modB"
    for (const [, entries] of byFuzzyKey) {
      if (entries.length < 2) continue;

      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        const roleA = a.participant.role;
        if (!INITIATOR_ROLES.has(roleA)) continue;

        const complementRole = ROLE_COMPLEMENTS[roleA];
        if (!complementRole) continue;

        for (let j = 0; j < entries.length; j++) {
          if (i === j) continue;
          const b = entries[j];
          if (b.participant.role !== complementRole) continue;
          if (a.participant.moduleId === b.participant.moduleId) continue;
          if (a.contract.id === b.contract.id) continue; // already handled by exact matching

          const dedupKey = `${a.contract.id}:${b.contract.id}:${a.participant.moduleId}:${b.participant.moduleId}`;
          if (matched.has(dedupKey)) continue;
          matched.add(dedupKey);

          results.push({
            contractId: a.contract.id,
            protocol: a.contract.protocol,
            key: a.contract.key,
            normalizedKey: a.contract.normalizedKey,
            initiator: a.participant,
            handler: b.participant,
            fromModuleId: a.participant.moduleId!,
            toModuleId: b.participant.moduleId!,
          });
        }
      }
    }

    return results;
  }
}
