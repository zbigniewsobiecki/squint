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

    it('updates flow name, slug, and description from CSV (compound key matching)', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views dashboard","Displays main dashboard with metrics"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('user views dashboard');
      expect(result[0].slug).toBe('user-views-dashboard');
      expect(result[0].description).toBe('Displays main dashboard with metrics');
    });

    it('preserves original flow when no matching compound key in CSV', () => {
      const response = `\`\`\`csv
entry_point,name,description
non.matching.path::view,"user views something","Some desc"
\`\`\``;

      const original = makeFlow({ name: 'KeepMe', slug: 'keep-me' });
      const result = parseCSV(response, [original]);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('KeepMe');
      expect(result[0].slug).toBe('keep-me');
    });

    it('handles multiple flows with different entryPaths matched by compound key', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.customers.CustomerList::view,"user views customers","Lists all customers"
project.customers.CreateCustomer::view,"admin creates customer","Creates a new customer record"
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
project.frontend.Home::view,"user views home","Home page"`;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].name).toBe('user views home');
    });

    it('preserves original when CSV line has too few fields', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"short"
\`\`\``;

      const original = makeFlow({ name: 'KeepThis', slug: 'keep-this', description: 'original desc' });
      const result = parseCSV(response, [original]);

      expect(result[0].name).toBe('KeepThis');
      expect(result[0].description).toBe('original desc');
    });

    it('generates correct slug from enhanced name', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"admin creates new vehicle","Creates vehicle record"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].slug).toBe('admin-creates-new-vehicle');
    });

    it('strips quotes from name and description', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views ""dashboard""","Shows the ""main"" dashboard"
\`\`\``;

      const flows = [makeFlow()];
      const result = parseCSV(response, flows);

      expect(result[0].name).not.toContain('"');
      expect(result[0].description).not.toContain('"');
    });

    it('preserves non-name/slug/description fields from original', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"admin views dashboard","Dashboard view"
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
project.frontend.Home::view,"system processes batch job","Runs scheduled batch processing"
\`\`\``;

      const original = makeFlow({ stakeholder: 'user' });
      const result = parseCSV(response, [original]);

      expect(result[0].stakeholder).toBe('system');
    });

    it('preserves original stakeholder when name has no valid stakeholder prefix', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"unknown action here","Some description"
\`\`\``;

      const original = makeFlow({ stakeholder: 'admin' });
      const result = parseCSV(response, [original]);

      expect(result[0].stakeholder).toBe('admin');
    });

    describe('actionType and targetEntity are preserved from original (not overridden by name parsing)', () => {
      it('actionType preserved even when LLM name has a different verb', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user deletes asset","Removes the selected asset"
\`\`\``;

        const original = makeFlow({ actionType: 'view' });
        const result = parseCSV(response, [original]);

        // actionType should stay as the original tracer-set value, not overridden by name parsing
        expect(result[0].actionType).toBe('view');
      });

      it('targetEntity preserved even when LLM name has a different entity', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views content_section","Shows the content section"
\`\`\``;

        const original = makeFlow({ targetEntity: 'dashboard' });
        const result = parseCSV(response, [original]);

        // targetEntity should stay as the original tracer-set value
        expect(result[0].targetEntity).toBe('dashboard');
      });

      it('null targetEntity preserved even when LLM name has entity words', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views api key","Shows API key details"
\`\`\``;

        const flows = [makeFlow({ targetEntity: null })];
        const result = parseCSV(response, flows);

        // targetEntity stays null — enhancer does not derive from name
        expect(result[0].targetEntity).toBeNull();
      });

      it('actionType preserved even with multi-word verb "logs into" in name', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user logs into system","Authenticates the user"
\`\`\``;

        const flows = [makeFlow({ actionType: 'view', targetEntity: null })];
        const result = parseCSV(response, flows);

        // Both should be preserved from original, not derived from name
        expect(result[0].actionType).toBe('view');
        expect(result[0].targetEntity).toBeNull();
      });

      it('null targetEntity stays null even when name has "unknown" entity', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user processes unknown","Handles something"
\`\`\``;

        const original = makeFlow({ targetEntity: null });
        const result = parseCSV(response, [original]);

        expect(result[0].targetEntity).toBeNull();
      });

      it('actionType preserved when name has unrecognized verb', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user navigates dashboard","Goes to dashboard"
\`\`\``;

        const original = makeFlow({ actionType: 'view' });
        const result = parseCSV(response, [original]);

        expect(result[0].actionType).toBe('view');
      });

      it('targetEntity preserved when name is too short to have entity', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views","Views something"
\`\`\``;

        const original = makeFlow({ targetEntity: 'dashboard' });
        const result = parseCSV(response, [original]);

        expect(result[0].targetEntity).toBe('dashboard');
      });
    });

    it('only matches the flow with correct compound key, others keep original', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views home","Home page"
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

    describe('multi-action flows with same entryPath', () => {
      it('each CRUD action gets its own enhancement via compound key', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.pages.vehicles.Vehicles::view,"user views vehicle list","Displays all vehicles"
project.frontend.pages.vehicles.Vehicles::create,"user creates vehicle","Adds a new vehicle record"
project.frontend.pages.vehicles.Vehicles::update,"user updates vehicle","Modifies existing vehicle details"
project.frontend.pages.vehicles.Vehicles::delete,"user deletes vehicle","Removes a vehicle record"
\`\`\``;

        const flows = [
          makeFlow({
            name: 'ViewVehicles',
            slug: 'view-vehicles',
            entryPath: 'project.frontend.pages.vehicles.Vehicles',
            actionType: 'view',
            targetEntity: 'vehicle',
            interactionIds: [1, 2],
          }),
          makeFlow({
            name: 'CreateVehicle',
            slug: 'create-vehicle',
            entryPath: 'project.frontend.pages.vehicles.Vehicles',
            actionType: 'create',
            targetEntity: 'vehicle',
            interactionIds: [3, 4],
          }),
          makeFlow({
            name: 'UpdateVehicle',
            slug: 'update-vehicle',
            entryPath: 'project.frontend.pages.vehicles.Vehicles',
            actionType: 'update',
            targetEntity: 'vehicle',
            interactionIds: [5, 6],
          }),
          makeFlow({
            name: 'DeleteVehicle',
            slug: 'delete-vehicle',
            entryPath: 'project.frontend.pages.vehicles.Vehicles',
            actionType: 'delete',
            targetEntity: 'vehicle',
            interactionIds: [7, 8],
          }),
        ];

        const result = parseCSV(response, flows);

        expect(result).toHaveLength(4);

        // Each flow gets its own distinct enhancement
        expect(result[0].name).toBe('user views vehicle list');
        expect(result[0].actionType).toBe('view');
        expect(result[0].targetEntity).toBe('vehicle');

        expect(result[1].name).toBe('user creates vehicle');
        expect(result[1].actionType).toBe('create');
        expect(result[1].targetEntity).toBe('vehicle');

        expect(result[2].name).toBe('user updates vehicle');
        expect(result[2].actionType).toBe('update');
        expect(result[2].targetEntity).toBe('vehicle');

        expect(result[3].name).toBe('user deletes vehicle');
        expect(result[3].actionType).toBe('delete');
        expect(result[3].targetEntity).toBe('vehicle');
      });

      it('unmatched action from same entryPath keeps original', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.pages.vehicles.Vehicles::view,"user views vehicle list","Displays all vehicles"
\`\`\``;

        const flows = [
          makeFlow({
            name: 'ViewVehicles',
            entryPath: 'project.frontend.pages.vehicles.Vehicles',
            actionType: 'view',
            targetEntity: 'vehicle',
          }),
          makeFlow({
            name: 'CreateVehicle',
            entryPath: 'project.frontend.pages.vehicles.Vehicles',
            actionType: 'create',
            targetEntity: 'vehicle',
          }),
        ];

        const result = parseCSV(response, flows);

        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('user views vehicle list');
        // Create flow not in CSV response — keeps original
        expect(result[1].name).toBe('CreateVehicle');
        expect(result[1].actionType).toBe('create');
      });

      it('flow with unknown actionType uses ::unknown compound key', () => {
        const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::unknown,"user views home","Home page"
\`\`\``;

        const flows = [makeFlow({ actionType: undefined as any })];
        const result = parseCSV(response, flows);

        expect(result[0].name).toBe('user views home');
      });
    });
  });

  describe('5-column CSV parsing (entry_point, name, description, action_type, target_entity)', () => {
    const enhancer = createEnhancer();
    const parseCSV = (response: string, flows: FlowSuggestion[]) =>
      (enhancer as any).parseEnhancedFlowsCSV(response, flows);

    it('backfills actionType from LLM when original is null', () => {
      const response = `\`\`\`csv
entry_point,name,description,action_type,target_entity
project.frontend.Home::unknown,"user views dashboard","Displays dashboard",view,dashboard
\`\`\``;

      const flows = [makeFlow({ actionType: null, targetEntity: null, entryPath: 'project.frontend.Home' })];
      // The compound key uses 'unknown' when actionType is null
      const result = parseCSV(response, flows);

      expect(result[0].actionType).toBe('view');
      expect(result[0].targetEntity).toBe('dashboard');
    });

    it('does NOT override existing actionType from LLM response', () => {
      const response = `\`\`\`csv
entry_point,name,description,action_type,target_entity
project.frontend.Home::view,"user views dashboard","Displays dashboard",create,widget
\`\`\``;

      const flows = [makeFlow({ actionType: 'view', targetEntity: 'dashboard' })];
      const result = parseCSV(response, flows);

      // Original actionType and targetEntity should be preserved
      expect(result[0].actionType).toBe('view');
      expect(result[0].targetEntity).toBe('dashboard');
    });

    it('backfills targetEntity from LLM when original is null', () => {
      const response = `\`\`\`csv
entry_point,name,description,action_type,target_entity
project.frontend.Home::view,"user views vehicles","Lists vehicles",view,vehicle
\`\`\``;

      const flows = [makeFlow({ actionType: 'view', targetEntity: null })];
      const result = parseCSV(response, flows);

      // actionType already set, should not change; targetEntity should be backfilled
      expect(result[0].actionType).toBe('view');
      expect(result[0].targetEntity).toBe('vehicle');
    });

    it('handles 3-column CSV gracefully (no actionType/targetEntity columns)', () => {
      const response = `\`\`\`csv
entry_point,name,description
project.frontend.Home::view,"user views dashboard","Displays dashboard"
\`\`\``;

      const flows = [makeFlow({ actionType: null, targetEntity: null })];
      const result = parseCSV(response, flows);

      // No columns 4-5, so actionType and targetEntity stay null
      expect(result[0].actionType).toBeNull();
      expect(result[0].targetEntity).toBeNull();
    });

    it('rejects invalid actionType from LLM', () => {
      const response = `\`\`\`csv
entry_point,name,description,action_type,target_entity
project.frontend.Home::unknown,"user xyz dashboard","Does something",invalidaction,dashboard
\`\`\``;

      const flows = [makeFlow({ actionType: null, targetEntity: null, entryPath: 'project.frontend.Home' })];
      const result = parseCSV(response, flows);

      // Invalid actionType should not be applied
      expect(result[0].actionType).toBeNull();
      // targetEntity should still be backfilled
      expect(result[0].targetEntity).toBe('dashboard');
    });

    it('handles empty action_type and target_entity columns', () => {
      const response = `\`\`\`csv
entry_point,name,description,action_type,target_entity
project.frontend.Home::view,"user views home","Home page",,
\`\`\``;

      const flows = [makeFlow({ actionType: 'view', targetEntity: null })];
      const result = parseCSV(response, flows);

      // Empty columns → null, originals preserved
      expect(result[0].actionType).toBe('view');
      expect(result[0].targetEntity).toBeNull();
    });
  });

  describe('buildEnhancementUserPrompt', () => {
    const enhancer = createEnhancer();
    const buildPrompt = (flows: FlowSuggestion[], interactionMap: Map<number, any>) =>
      (enhancer as any).buildEnhancementUserPrompt(flows, interactionMap);

    it('emits compound entry key with actionType suffix', () => {
      const flows = [
        makeFlow({
          entryPath: 'project.frontend.pages.vehicles.Vehicles',
          actionType: 'create',
        }),
      ];
      const interactionMap = new Map();

      const prompt = buildPrompt(flows, interactionMap);

      expect(prompt).toContain('Entry: project.frontend.pages.vehicles.Vehicles::create');
    });

    it('uses ::unknown suffix when actionType is missing', () => {
      const flows = [
        makeFlow({
          entryPath: 'project.frontend.Home',
          actionType: undefined as any,
        }),
      ];
      const interactionMap = new Map();

      const prompt = buildPrompt(flows, interactionMap);

      expect(prompt).toContain('Entry: project.frontend.Home::unknown');
    });
  });
});
