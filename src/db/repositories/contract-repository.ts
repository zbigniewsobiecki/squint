import type Database from 'better-sqlite3';
import { ensureContractsTables } from '../schema-manager.js';
import type { Contract, ContractParticipant, ContractWithParticipants } from '../schema.js';

/**
 * Repository for contract (cross-process communication channel) operations.
 */
export class ContractRepository {
  constructor(private db: Database.Database) {}

  // ============================================================
  // Core CRUD
  // ============================================================

  /**
   * Upsert a contract by (protocol, normalizedKey). Returns the contract ID.
   */
  upsertContract(protocol: string, key: string, normalizedKey: string, description?: string): number {
    ensureContractsTables(this.db);

    const existing = this.db
      .prepare('SELECT id FROM contracts WHERE protocol = ? AND normalized_key = ?')
      .get(protocol, normalizedKey) as { id: number } | undefined;

    if (existing) {
      if (description) {
        this.db.prepare('UPDATE contracts SET description = ? WHERE id = ?').run(description, existing.id);
      }
      return existing.id;
    }

    const result = this.db
      .prepare('INSERT INTO contracts (protocol, key, normalized_key, description) VALUES (?, ?, ?, ?)')
      .run(protocol, key, normalizedKey, description ?? null);

    return result.lastInsertRowid as number;
  }

  /**
   * Add a participant to a contract. Returns the participant ID.
   * Skips if the (contract_id, definition_id) pair already exists.
   */
  addParticipant(contractId: number, definitionId: number, moduleId: number | null, role: string): number {
    ensureContractsTables(this.db);

    const existing = this.db
      .prepare('SELECT id FROM contract_participants WHERE contract_id = ? AND definition_id = ?')
      .get(contractId, definitionId) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    const result = this.db
      .prepare('INSERT INTO contract_participants (contract_id, definition_id, module_id, role) VALUES (?, ?, ?, ?)')
      .run(contractId, definitionId, moduleId, role);

    return result.lastInsertRowid as number;
  }

  // ============================================================
  // Queries
  // ============================================================

  /**
   * Get all contracts.
   */
  getAll(): Contract[] {
    ensureContractsTables(this.db);
    return this.db
      .prepare(
        `SELECT id, protocol, key, normalized_key as normalizedKey, description, created_at as createdAt
         FROM contracts ORDER BY protocol, normalized_key`
      )
      .all() as Contract[];
  }

  /**
   * Get a contract with its participants.
   */
  getWithParticipants(contractId: number): ContractWithParticipants | null {
    ensureContractsTables(this.db);

    const contract = this.db
      .prepare(
        `SELECT id, protocol, key, normalized_key as normalizedKey, description, created_at as createdAt
         FROM contracts WHERE id = ?`
      )
      .get(contractId) as Contract | undefined;

    if (!contract) return null;

    const participants = this.db
      .prepare(
        `SELECT id, contract_id as contractId, definition_id as definitionId,
                module_id as moduleId, role
         FROM contract_participants WHERE contract_id = ?`
      )
      .all(contractId) as ContractParticipant[];

    return { ...contract, participants };
  }

  /**
   * Get all contracts with their participants.
   */
  getAllWithParticipants(): ContractWithParticipants[] {
    ensureContractsTables(this.db);

    const contracts = this.getAll();
    const allParticipants = this.db
      .prepare(
        `SELECT id, contract_id as contractId, definition_id as definitionId,
                module_id as moduleId, role
         FROM contract_participants ORDER BY contract_id`
      )
      .all() as ContractParticipant[];

    const participantsByContract = new Map<number, ContractParticipant[]>();
    for (const p of allParticipants) {
      const existing = participantsByContract.get(p.contractId) ?? [];
      existing.push(p);
      participantsByContract.set(p.contractId, existing);
    }

    return contracts.map((c) => ({
      ...c,
      participants: participantsByContract.get(c.id) ?? [],
    }));
  }

  /**
   * Get contracts by protocol.
   */
  getByProtocol(protocol: string): Contract[] {
    ensureContractsTables(this.db);
    return this.db
      .prepare(
        `SELECT id, protocol, key, normalized_key as normalizedKey, description, created_at as createdAt
         FROM contracts WHERE protocol = ? ORDER BY normalized_key`
      )
      .all(protocol) as Contract[];
  }

  /**
   * Get matched contracts (contracts with participants having complementary roles).
   */
  getMatchedContracts(): ContractWithParticipants[] {
    return this.getAllWithParticipants().filter((c) => {
      const roles = new Set(c.participants.map((p) => p.role));
      return roles.size >= 2;
    });
  }

  /**
   * Get unmatched contracts (one-sided — only one role).
   */
  getUnmatchedContracts(): ContractWithParticipants[] {
    return this.getAllWithParticipants().filter((c) => {
      const roles = new Set(c.participants.map((p) => p.role));
      return roles.size < 2;
    });
  }

  /**
   * Get participants for a specific module.
   */
  getParticipantsByModule(moduleId: number): Array<ContractParticipant & { protocol: string; normalizedKey: string }> {
    ensureContractsTables(this.db);
    return this.db
      .prepare(
        `SELECT cp.id, cp.contract_id as contractId, cp.definition_id as definitionId,
                cp.module_id as moduleId, cp.role,
                c.protocol, c.normalized_key as normalizedKey
         FROM contract_participants cp
         JOIN contracts c ON cp.contract_id = c.id
         WHERE cp.module_id = ?`
      )
      .all(moduleId) as Array<ContractParticipant & { protocol: string; normalizedKey: string }>;
  }

  /**
   * Get total contract count.
   */
  getCount(): number {
    ensureContractsTables(this.db);
    const row = this.db.prepare('SELECT COUNT(*) as count FROM contracts').get() as { count: number };
    return row.count;
  }

  /**
   * Get protocol breakdown: count of contracts per protocol.
   */
  getProtocolBreakdown(): Array<{ protocol: string; count: number }> {
    ensureContractsTables(this.db);
    return this.db
      .prepare('SELECT protocol, COUNT(*) as count FROM contracts GROUP BY protocol ORDER BY count DESC')
      .all() as Array<{ protocol: string; count: number }>;
  }

  /**
   * Get participant count.
   */
  getParticipantCount(): number {
    ensureContractsTables(this.db);
    const row = this.db.prepare('SELECT COUNT(*) as count FROM contract_participants').get() as { count: number };
    return row.count;
  }

  /**
   * Get communication topology between process groups.
   * Groups contracts by the process groups of their participants' modules.
   */
  getTopologyBetweenGroups(moduleToGroup: Map<number, string>): Array<{
    fromGroupLabel: string;
    toGroupLabel: string;
    contractCount: number;
    protocols: string[];
  }> {
    const contractsWithParticipants = this.getAllWithParticipants();
    const topologyMap = new Map<string, { count: number; protocols: Set<string> }>();

    for (const contract of contractsWithParticipants) {
      // Group participants by their process group
      const groupParticipants = new Map<string, ContractParticipant[]>();
      for (const p of contract.participants) {
        if (p.moduleId === null) continue;
        const groupLabel = moduleToGroup.get(p.moduleId);
        if (!groupLabel) continue;
        const existing = groupParticipants.get(groupLabel) ?? [];
        existing.push(p);
        groupParticipants.set(groupLabel, existing);
      }

      // Create edges between groups
      const groups = [...groupParticipants.keys()];
      for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          const key = [groups[i], groups[j]].sort().join('↔');
          const existing = topologyMap.get(key) ?? { count: 0, protocols: new Set() };
          existing.count++;
          existing.protocols.add(contract.protocol);
          topologyMap.set(key, existing);
        }
      }
    }

    return [...topologyMap.entries()].map(([key, value]) => {
      const [fromGroupLabel, toGroupLabel] = key.split('↔');
      return {
        fromGroupLabel,
        toGroupLabel,
        contractCount: value.count,
        protocols: [...value.protocols],
      };
    });
  }

  /**
   * Find a contract by protocol and normalizedKey.
   */
  findByProtocolAndKey(protocol: string, normalizedKey: string): Contract | null {
    ensureContractsTables(this.db);
    return (
      (this.db
        .prepare(
          `SELECT id, protocol, key, normalized_key as normalizedKey, description, created_at as createdAt
           FROM contracts WHERE protocol = ? AND normalized_key = ?`
        )
        .get(protocol, normalizedKey) as Contract | undefined) ?? null
    );
  }

  /**
   * Get participants for a contract with definition and module details.
   */
  getParticipantsWithDetails(contractId: number): Array<
    ContractParticipant & {
      definitionName: string;
      filePath: string;
      line: number;
      modulePath: string | null;
    }
  > {
    ensureContractsTables(this.db);
    return this.db
      .prepare(
        `SELECT cp.id, cp.contract_id as contractId, cp.definition_id as definitionId,
                cp.module_id as moduleId, cp.role,
                d.name as definitionName, f.path as filePath, d.line,
                m.full_path as modulePath
         FROM contract_participants cp
         JOIN definitions d ON cp.definition_id = d.id
         JOIN files f ON d.file_id = f.id
         LEFT JOIN modules m ON cp.module_id = m.id
         WHERE cp.contract_id = ?`
      )
      .all(contractId) as Array<
      ContractParticipant & {
        definitionName: string;
        filePath: string;
        line: number;
        modulePath: string | null;
      }
    >;
  }

  // ============================================================
  // Backfill
  // ============================================================

  /**
   * Backfill NULL module_ids by looking up definition → module_members.
   * Useful when contracts were extracted before modules existed,
   * or for standalone `contracts extract` runs.
   */
  backfillModuleIds(): number {
    ensureContractsTables(this.db);
    const result = this.db
      .prepare(`
      UPDATE contract_participants
      SET module_id = (
        SELECT mm.module_id
        FROM module_members mm
        WHERE mm.definition_id = contract_participants.definition_id
        LIMIT 1
      )
      WHERE module_id IS NULL
      AND EXISTS (
        SELECT 1 FROM module_members mm
        WHERE mm.definition_id = contract_participants.definition_id
      )
    `)
      .run();
    return result.changes;
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Delete all contracts and participants.
   */
  clear(): void {
    ensureContractsTables(this.db);
    this.db.exec('DELETE FROM contract_participants');
    this.db.exec('DELETE FROM contracts');
  }
}
