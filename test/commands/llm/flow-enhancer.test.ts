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

    it('updates flow name, slug, and description from CSV', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"user views dashboard","Displays main dashboard with metrics"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('user views dashboard');
      expect(result[0].slug).toBe('user-views-dashboard');
      expect(result[0].description).toBe('Displays main dashboard with metrics');
    });

    it('preserves original flow when CSV line is missing', () => {
      const response = `\`\`\`csv
entry_point,name,description
\`\`\``;

      const original = makeFlow({ name: 'KeepMe', slug: 'keep-me' });
      const result = parseCSV(response, [original]);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('KeepMe');
      expect(result[0].slug).toBe('keep-me');
    });

    it('handles multiple flows', () => {
      const response = `\`\`\`csv
entry_point,name,description
CustomerList,"user views customers","Lists all customers"
CreateCustomer,"admin creates customer","Creates a new customer record"
\`\`\``;

      const flows = [makeFlow({ name: 'Flow1', slug: 'flow-1' }), makeFlow({ name: 'Flow2', slug: 'flow-2' })];

      const result = parseCSV(response, flows);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('user views customers');
      expect(result[1].name).toBe('admin creates customer');
    });

    it('handles response without code fences', () => {
      const response = `entry_point,name,description
Home,"user views home","Home page"`;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].name).toBe('user views home');
    });

    it('preserves original when CSV line has too few fields', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"short"
\`\`\``;

      const original = makeFlow({ name: 'KeepThis', slug: 'keep-this', description: 'original desc' });
      const result = parseCSV(response, [original]);

      expect(result[0].name).toBe('KeepThis');
      expect(result[0].description).toBe('original desc');
    });

    it('generates correct slug from enhanced name', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"admin creates new vehicle","Creates vehicle record"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].slug).toBe('admin-creates-new-vehicle');
    });

    it('strips quotes from name and description', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"user views ""dashboard""","Shows the ""main"" dashboard"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].name).not.toContain('"');
      expect(result[0].description).not.toContain('"');
    });

    it('preserves non-name/slug/description fields from original', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"admin views dashboard","Dashboard view"
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
Home,"system processes batch job","Runs scheduled batch processing"
\`\`\``;

      const original = makeFlow({ stakeholder: 'user' });
      const result = parseCSV(response, [original]);

      expect(result[0].stakeholder).toBe('system');
    });

    it('preserves original stakeholder when name has no valid stakeholder prefix', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"unknown action here","Some description"
\`\`\``;

      const original = makeFlow({ stakeholder: 'admin' });
      const result = parseCSV(response, [original]);

      expect(result[0].stakeholder).toBe('admin');
    });

    it('handles more flows than CSV lines', () => {
      const response = `\`\`\`csv
entry_point,name,description
Home,"user views home","Home page"
\`\`\``;

      const flows = [
        makeFlow({ name: 'Flow1', slug: 'flow-1' }),
        makeFlow({ name: 'Flow2', slug: 'flow-2' }),
        makeFlow({ name: 'Flow3', slug: 'flow-3' }),
      ];

      const result = parseCSV(response, flows);

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('user views home');
      expect(result[1].name).toBe('Flow2');
      expect(result[2].name).toBe('Flow3');
    });
  });
});
