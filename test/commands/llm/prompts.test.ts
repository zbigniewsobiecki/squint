import { describe, it, expect } from 'vitest';
import {
  buildFlowSystemPrompt,
  buildFlowUserPrompt,
  type FlowCandidate,
} from '../../../src/commands/llm/_shared/prompts.js';

describe('Flow Prompts', () => {
  describe('buildFlowSystemPrompt', () => {
    it('returns a non-empty system prompt', () => {
      const prompt = buildFlowSystemPrompt();
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes instructions for naming flows', () => {
      const prompt = buildFlowSystemPrompt();
      expect(prompt).toContain('execution flow');
      expect(prompt).toContain('CSV');
      expect(prompt).toContain('flow_id');
      expect(prompt).toContain('name');
      expect(prompt).toContain('description');
    });

    it('includes naming guidelines', () => {
      const prompt = buildFlowSystemPrompt();
      expect(prompt).toContain('PascalCase');
      expect(prompt).toContain('action-oriented');
    });
  });

  describe('buildFlowUserPrompt', () => {
    it('formats a single flow candidate correctly', () => {
      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 100,
          entryPointName: 'UserController',
          entryPointKind: 'class',
          entryPointFilePath: '/project/controllers/user.controller.ts',
          steps: [
            {
              definitionId: 100,
              name: 'UserController',
              kind: 'class',
              filePath: '/project/controllers/user.controller.ts',
              depth: 0,
              moduleId: 1,
              moduleName: 'UserAPI',
              layer: 'controller',
            },
            {
              definitionId: 101,
              name: 'userService',
              kind: 'function',
              filePath: '/project/services/user.service.ts',
              depth: 1,
              moduleId: 2,
              moduleName: 'UserService',
              layer: 'service',
            },
          ],
          modulesCrossed: ['UserAPI', 'UserService'],
          dominantDomains: ['user-management'],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);

      expect(prompt).toContain('## Execution Flows to Name (1)');
      expect(prompt).toContain('### Flow #1');
      expect(prompt).toContain('Entry point: UserController (class)');
      expect(prompt).toContain('/project/controllers/user.controller.ts');
      expect(prompt).toContain('Domains: user-management');
      expect(prompt).toContain('Steps (2 total)');
      expect(prompt).toContain('1. UserController [controller] (UserAPI)');
      expect(prompt).toContain('2. userService [service] (UserService)');
      expect(prompt).toContain('Modules crossed: UserAPI → UserService');
    });

    it('formats multiple flow candidates', () => {
      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 100,
          entryPointName: 'Controller1',
          entryPointKind: 'function',
          entryPointFilePath: '/project/c1.ts',
          steps: [
            {
              definitionId: 100,
              name: 'Controller1',
              kind: 'function',
              filePath: '/project/c1.ts',
              depth: 0,
              moduleId: null,
              moduleName: null,
              layer: null,
            },
          ],
          modulesCrossed: [],
          dominantDomains: [],
        },
        {
          id: 2,
          entryPointId: 200,
          entryPointName: 'Controller2',
          entryPointKind: 'function',
          entryPointFilePath: '/project/c2.ts',
          steps: [
            {
              definitionId: 200,
              name: 'Controller2',
              kind: 'function',
              filePath: '/project/c2.ts',
              depth: 0,
              moduleId: null,
              moduleName: null,
              layer: null,
            },
          ],
          modulesCrossed: [],
          dominantDomains: [],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);

      expect(prompt).toContain('## Execution Flows to Name (2)');
      expect(prompt).toContain('### Flow #1');
      expect(prompt).toContain('### Flow #2');
      expect(prompt).toContain('Controller1');
      expect(prompt).toContain('Controller2');
    });

    it('handles steps without layer or module info', () => {
      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 100,
          entryPointName: 'SimpleController',
          entryPointKind: 'function',
          entryPointFilePath: '/project/controller.ts',
          steps: [
            {
              definitionId: 100,
              name: 'SimpleController',
              kind: 'function',
              filePath: '/project/controller.ts',
              depth: 0,
              moduleId: null,
              moduleName: null,
              layer: null,
            },
          ],
          modulesCrossed: [],
          dominantDomains: [],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);

      // Should just show name without layer or module decorators
      expect(prompt).toContain('1. SimpleController');
      // Should not have [layer] or (module) decorators
      expect(prompt).not.toContain('[null]');
      expect(prompt).not.toContain('(null)');
    });

    it('truncates steps list at 10 for large flows', () => {
      const manySteps = Array.from({ length: 15 }, (_, i) => ({
        definitionId: i,
        name: `Step${i}`,
        kind: 'function',
        filePath: `/project/step${i}.ts`,
        depth: i,
        moduleId: null,
        moduleName: null,
        layer: null,
      }));

      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 0,
          entryPointName: 'EntryPoint',
          entryPointKind: 'function',
          entryPointFilePath: '/project/entry.ts',
          steps: manySteps,
          modulesCrossed: [],
          dominantDomains: [],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);

      expect(prompt).toContain('Steps (15 total)');
      expect(prompt).toContain('Step0');
      expect(prompt).toContain('Step9');
      expect(prompt).not.toContain('11. Step10');
      expect(prompt).toContain('... and 5 more steps');
    });

    it('omits modules crossed when empty', () => {
      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 100,
          entryPointName: 'Controller',
          entryPointKind: 'function',
          entryPointFilePath: '/project/controller.ts',
          steps: [],
          modulesCrossed: [],
          dominantDomains: [],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);
      expect(prompt).not.toContain('Modules crossed:');
    });

    it('omits domains when empty', () => {
      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 100,
          entryPointName: 'Controller',
          entryPointKind: 'function',
          entryPointFilePath: '/project/controller.ts',
          steps: [],
          modulesCrossed: [],
          dominantDomains: [],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);
      expect(prompt).not.toContain('Domains:');
    });

    it('includes CSV format request at end', () => {
      const candidates: FlowCandidate[] = [
        {
          id: 1,
          entryPointId: 100,
          entryPointName: 'Controller',
          entryPointKind: 'function',
          entryPointFilePath: '/project/controller.ts',
          steps: [],
          modulesCrossed: [],
          dominantDomains: [],
        },
      ];

      const prompt = buildFlowUserPrompt(candidates);
      expect(prompt).toContain('Provide flow names and descriptions in CSV format.');
    });
  });
});
