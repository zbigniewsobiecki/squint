import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRepository } from '../../../src/db/repositories/file-repository.js';
import { InteractionAnalysis } from '../../../src/db/repositories/interaction-analysis.js';
import { InteractionRepository } from '../../../src/db/repositories/interaction-repository.js';
import { ModuleRepository } from '../../../src/db/repositories/module-repository.js';
import { SCHEMA } from '../../../src/db/schema.js';

describe('InteractionAnalysis', () => {
  let db: Database.Database;
  let repo: InteractionRepository;
  let moduleRepo: ModuleRepository;
  let fileRepo: FileRepository;
  let analysis: InteractionAnalysis;
  let rootId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    repo = new InteractionRepository(db);
    moduleRepo = new ModuleRepository(db);
    fileRepo = new FileRepository(db);
    analysis = new InteractionAnalysis(db);

    rootId = moduleRepo.ensureRoot();
  });

  afterEach(() => {
    db.close();
  });

  function createModule(slug: string, name: string): number {
    return moduleRepo.insert(rootId, slug, name);
  }

  describe('detectFanInAnomalies', () => {
    it('returns empty array when no interactions exist', () => {
      const anomalies = analysis.detectFanInAnomalies();
      expect(anomalies).toHaveLength(0);
    });

    it('returns empty array when no llm-inferred interactions exist', () => {
      const modA = createModule('a', 'A');
      const modB = createModule('b', 'B');
      repo.insert(modA, modB, { source: 'ast' });

      const anomalies = analysis.detectFanInAnomalies();
      expect(anomalies).toHaveLength(0);
    });

    it('does not flag modules with AST inbound edges', () => {
      const target = createModule('target', 'Target');
      const modules: number[] = [];
      for (let i = 0; i < 20; i++) {
        modules.push(createModule(`m${i}`, `Module ${i}`));
      }

      // 20 llm-inferred inbound to target
      for (const m of modules) {
        repo.insert(m, target, { source: 'llm-inferred' });
      }

      // But also 1 AST inbound — disqualifies the anomaly
      const astSource = createModule('ast-source', 'AST Source');
      repo.insert(astSource, target, { source: 'ast' });

      const anomalies = analysis.detectFanInAnomalies();
      expect(anomalies).toHaveLength(0);
    });

    it('does not flag modules with fan-in below absolute minimum (4)', () => {
      const target = createModule('target', 'Target');
      // Only 3 llm-inferred inbound (below threshold of 4)
      for (let i = 0; i < 3; i++) {
        const m = createModule(`m${i}`, `Module ${i}`);
        repo.insert(m, target, { source: 'llm-inferred' });
      }

      const anomalies = analysis.detectFanInAnomalies();
      expect(anomalies).toHaveLength(0);
    });

    it('flags module with high llm fan-in and zero AST fan-in', () => {
      const target = createModule('seed-utils', 'Seed Utils');

      // Create many modules with normal fan-in (1-2 each) to establish baseline
      const normalTargets: number[] = [];
      for (let i = 0; i < 30; i++) {
        normalTargets.push(createModule(`normal-t${i}`, `Normal Target ${i}`));
      }
      for (let i = 0; i < 30; i++) {
        const src = createModule(`normal-s${i}`, `Normal Source ${i}`);
        // Each normal target gets 1 llm-inferred inbound
        repo.insert(src, normalTargets[i], { source: 'llm-inferred' });
      }

      // Now create 20 llm-inferred inbound to the anomalous target
      for (let i = 0; i < 20; i++) {
        const m = createModule(`halluc-${i}`, `Hallucinator ${i}`);
        repo.insert(m, target, { source: 'llm-inferred' });
      }

      const anomalies = analysis.detectFanInAnomalies();
      expect(anomalies.length).toBeGreaterThanOrEqual(1);

      const seedAnomaly = anomalies.find((a) => a.modulePath.includes('seed-utils'));
      expect(seedAnomaly).toBeDefined();
      expect(seedAnomaly!.llmFanIn).toBe(20);
      expect(seedAnomaly!.astFanIn).toBe(0);
    });
  });
});
