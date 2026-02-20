import type { IndexDatabase } from '../../db/database.js';

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

function isMatched(roles: Set<string>): boolean {
  for (const role of roles) {
    const complement = ROLE_COMPLEMENTS[role];
    if (complement && roles.has(complement)) return true;
  }
  return false;
}

export function getContractsData(database: IndexDatabase): {
  contracts: Array<{
    id: number;
    protocol: string;
    key: string;
    normalizedKey: string;
    description: string | null;
    participants: Array<{
      id: number;
      definitionId: number;
      definitionName: string;
      moduleId: number | null;
      modulePath: string | null;
      role: string;
    }>;
    matched: boolean;
  }>;
  stats: {
    total: number;
    matched: number;
    unmatched: number;
    byProtocol: Record<string, number>;
  };
} {
  try {
    const contractsWithParticipants = database.contracts.getAllWithParticipants();

    // Build lookup maps for definition names and module paths
    const conn = database.getConnection();
    const defNames = new Map<number, string>();
    const modulePaths = new Map<number, string>();

    // Collect all needed IDs
    const defIds = new Set<number>();
    const moduleIds = new Set<number>();
    for (const c of contractsWithParticipants) {
      for (const p of c.participants) {
        defIds.add(p.definitionId);
        if (p.moduleId !== null) moduleIds.add(p.moduleId);
      }
    }

    // Batch-load definition names
    if (defIds.size > 0) {
      const rows = conn
        .prepare(`SELECT id, name FROM definitions WHERE id IN (${[...defIds].map(() => '?').join(',')})`)
        .all(...defIds) as Array<{ id: number; name: string }>;
      for (const r of rows) defNames.set(r.id, r.name);
    }

    // Batch-load module paths
    if (moduleIds.size > 0) {
      const rows = conn
        .prepare(`SELECT id, full_path FROM modules WHERE id IN (${[...moduleIds].map(() => '?').join(',')})`)
        .all(...moduleIds) as Array<{ id: number; full_path: string }>;
      for (const r of rows) modulePaths.set(r.id, r.full_path);
    }

    let matchedCount = 0;
    let unmatchedCount = 0;
    const byProtocol: Record<string, number> = {};

    const contracts = contractsWithParticipants.map((c) => {
      const roles = new Set(c.participants.map((p) => p.role));
      const matched = isMatched(roles);
      if (matched) matchedCount++;
      else unmatchedCount++;
      byProtocol[c.protocol] = (byProtocol[c.protocol] ?? 0) + 1;

      return {
        id: c.id,
        protocol: c.protocol,
        key: c.key,
        normalizedKey: c.normalizedKey,
        description: c.description,
        participants: c.participants.map((p) => ({
          id: p.id,
          definitionId: p.definitionId,
          definitionName: defNames.get(p.definitionId) ?? 'unknown',
          moduleId: p.moduleId,
          modulePath: p.moduleId !== null ? (modulePaths.get(p.moduleId) ?? null) : null,
          role: p.role,
        })),
        matched,
      };
    });

    return {
      contracts,
      stats: {
        total: contracts.length,
        matched: matchedCount,
        unmatched: unmatchedCount,
        byProtocol,
      },
    };
  } catch {
    return {
      contracts: [],
      stats: { total: 0, matched: 0, unmatched: 0, byProtocol: {} },
    };
  }
}
