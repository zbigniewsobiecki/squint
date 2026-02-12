import { describe, expect, it } from 'vitest';
import { FlowEnhancer } from '../../../src/commands/llm/flows/flow-enhancer.js';
import type { FlowSuggestion } from '../../../src/commands/llm/flows/types.js';

/**
 * Tests for FlowEnhancer's pure logic: parseEnhancedFlowsCSV and stakeholderToActor.
 * Private methods accessed via `(instance as any)`.
 */

function createEnhancer() {
  const mockCommand = { log: () => {}, warn: () => {} } as any;
  return new FlowEnhancer(mockCommand, false);
}

function makeFlow(overrides: Partial<FlowSuggestion> = {}): FlowSuggestion {
  return {
    name: 'OriginalFlow',
    slug: 'original-flow',
    entryPointModuleId: 1,
    entryPointId: 10,
    entryPath: 'project.frontend.Home',
    stakeholder: 'user',
    description: 'Original description',
    interactionIds: [100],
    definitionSteps: [],
    inferredSteps: [],
    actionType: 'view',
    targetEntity: 'dashboard',
    tier: 1,
    subflowSlugs: [],
    ...overrides,
  };
}

describe('FlowEnhancer', () => {
  describe('stakeholderToActor', () => {
    const enhancer = createEnhancer();
    const toActor = (s: string) => (enhancer as any).stakeholderToActor(s);

    it('maps admin to Admin', () => {
      expect(toActor('admin')).toBe('Admin');
    });

    it('maps user to User', () => {
      expect(toActor('user')).toBe('User');
    });

    it('maps system to System', () => {
      expect(toActor('system')).toBe('System');
    });

    it('maps developer to Developer', () => {
      expect(toActor('developer')).toBe('Developer');
    });

    it('maps external to External service', () => {
      expect(toActor('external')).toBe('External service');
    });

    it('defaults to User for unknown stakeholders', () => {
      expect(toActor('unknown')).toBe('User');
      expect(toActor('')).toBe('User');
    });
  });

  describe('parseEnhancedFlowsCSV', () => {
    const enhancer = createEnhancer();
    const parseCSV = (response: string, flows: FlowSuggestion[]) =>
      (enhancer as any).parseEnhancedFlowsCSV(response, flows);

    it('updates flow name, slug, and description from CSV (key-based matching)', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user views dashboard","Displays main dashboard with metrics"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('user views dashboard');
      expect(result[0].slug).toBe('user-views-dashboard');
      expect(result[0].description).toBe('Displays main dashboard with metrics');
    });

    it('preserves original flow when no matching entry_point in CSV', () => {
      const response = `\`\`\`csv
entry_point,name,description
non.matching.path,"user views something","Some desc"
\`\`\``;

      const original = makeFlow({ name: 'KeepMe', slug: 'keep-me' });
      const result = parseCSV(response, [original]);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('KeepMe');
      expect(result[0].slug).toBe('keep-me');
    });

    it('handles multiple flows matched by entry_point key', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.customers.CustomerList,"user views customers","Lists all customers"
project.customers.CreateCustomer,"admin creates customer","Creates a new customer record"
\`\`\``;

      const flows = [
        makeFlow({ name: 'Flow1', slug: 'flow-1', entryPath: 'project.customers.CustomerList' }),
        makeFlow({ name: 'Flow2', slug: 'flow-2', entryPath: 'project.customers.CreateCustomer' }),
      ];

      const result = parseCSV(response, flows);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('user views customers');
      expect(result[1].name).toBe('admin creates customer');
    });

    it('handles response without code fences', () => {
      const response = `entry_point,name,description
project.frontend.Home,"user views home","Home page"`;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].name).toBe('user views home');
    });

    it('preserves original when CSV line has too few fields', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"short"
\`\`\``;

      const original = makeFlow({ name: 'KeepThis', slug: 'keep-this', description: 'original desc' });
      const result = parseCSV(response, [original]);

      expect(result[0].name).toBe('KeepThis');
      expect(result[0].description).toBe('original desc');
    });

    it('generates correct slug from enhanced name', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"admin creates new vehicle","Creates vehicle record"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].slug).toBe('admin-creates-new-vehicle');
    });

    it('strips quotes from name and description', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user views ""dashboard""","Shows the ""main"" dashboard"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].name).not.toContain('"');
      expect(result[0].description).not.toContain('"');
    });

    it('preserves non-name/slug/description fields from original', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"admin views dashboard","Dashboard view"
\`\`\``;

      const original = makeFlow({
        entryPointModuleId: 42,
        entryPointId: 100,
        stakeholder: 'admin',
        interactionIds: [1, 2, 3],
        actionType: 'view',
        targetEntity: 'dashboard',
      });

      const result = parseCSV(response, [original]);

      expect(result[0].entryPointModuleId).toBe(42);
      expect(result[0].entryPointId).toBe(100);
      expect(result[0].stakeholder).toBe('admin');
      expect(result[0].interactionIds).toEqual([1, 2, 3]);
      expect(result[0].actionType).toBe('view');
      expect(result[0].targetEntity).toBe('dashboard');
    });

    it('derives stakeholder from LLM-generated name', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"system processes batch job","Runs scheduled batch processing"
\`\`\``;

      const original = makeFlow({ stakeholder: 'user' });
      const result = parseCSV(response, [original]);

      expect(result[0].stakeholder).toBe('system');
    });

    it('preserves original stakeholder when name has no valid stakeholder prefix', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"unknown action here","Some description"
\`\`\``;

      const original = makeFlow({ stakeholder: 'admin' });
      const result = parseCSV(response, [original]);

      expect(result[0].stakeholder).toBe('admin');
    });

    describe('metadata derivation from name', () => {
      it('actionType overridden when verb differs from original', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user deletes asset","Removes the selected asset"
\`\`\``;

        const original = makeFlow({ actionType: 'view' });
        const result = parseCSV(response, [original]);

        expect(result[0].actionType).toBe('delete');
      });

      it('targetEntity overridden when name has real entity', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user views content_section","Shows the content section"
\`\`\``;

        const original = makeFlow({ targetEntity: null });
        const result = parseCSV(response, [original]);

        expect(result[0].targetEntity).toBe('content_section');
      });

      it('multi-word entity joined with underscore', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user views api key","Shows API key details"
\`\`\``;

        const flows = [makeFlow()];
        const result = parseCSV(response, flows);

        expect(result[0].targetEntity).toBe('api_key');
      });

      it('multi-word verb "logs into" parsed correctly', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user logs into system","Authenticates the user"
\`\`\``;

        const flows = [makeFlow({ actionType: 'view', targetEntity: null })];
        const result = parseCSV(response, flows);

        expect(result[0].actionType).toBe('process');
        expect(result[0].targetEntity).toBe('system');
      });

      it('"unknown" entity filtered out, keeps original null', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user processes unknown","Handles something"
\`\`\``;

        const original = makeFlow({ targetEntity: null });
        const result = parseCSV(response, [original]);

        expect(result[0].targetEntity).toBeNull();
      });

      it('unrecognized verb falls back to original', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user navigates dashboard","Goes to dashboard"
\`\`\``;

        const original = makeFlow({ actionType: 'view' });
        const result = parseCSV(response, [original]);

        expect(result[0].actionType).toBe('view');
      });

      it('short name (no entity) keeps original targetEntity', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user views","Views something"
\`\`\``;

        const original = makeFlow({ targetEntity: 'dashboard' });
        const result = parseCSV(response, [original]);

        expect(result[0].targetEntity).toBe('dashboard');
      });
    });

    it('only matches the flow with correct entry_point, others keep original', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home,"user views home","Home page"
\`\`\``;

      const flows = [
        makeFlow({ name: 'Flow1', slug: 'flow-1', entryPath: 'project.frontend.Home' }),
        makeFlow({ name: 'Flow2', slug: 'flow-2', entryPath: 'project.frontend.Settings' }),
        makeFlow({ name: 'Flow3', slug: 'flow-3', entryPath: 'project.frontend.Profile' }),
      ];

      const result = parseCSV(response, flows);

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('user views home');
      expect(result[1].name).toBe('Flow2');
      expect(result[2].name).toBe('Flow3');
    });
  });
});
