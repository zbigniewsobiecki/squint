import { describe, expect, it } from 'vitest';
import {
  type EntryPointCandidate,
  type FlowConstructionContext,
  type GapFillingContext,
  buildEntryPointSystemPrompt,
  buildEntryPointUserPrompt,
  buildFlowConstructionSystemPrompt,
  buildFlowConstructionUserPrompt,
  buildGapFillingSystemPrompt,
  buildGapFillingUserPrompt,
  formatCoverageStats,
} from '../../../src/commands/llm/_shared/flow-prompts.js';
import type { FlowCoverageStats } from '../../../src/db/schema.js';

describe('Flow Prompts v2', () => {
  describe('Entry Point Classification', () => {
    it('buildEntryPointSystemPrompt returns a non-empty system prompt', () => {
      const prompt = buildEntryPointSystemPrompt();
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes classification categories', () => {
      const prompt = buildEntryPointSystemPrompt();
      expect(prompt).toContain('top_level');
      expect(prompt).toContain('subflow_candidate');
      expect(prompt).toContain('internal');
    });

    it('includes CSV format instructions', () => {
      const prompt = buildEntryPointSystemPrompt();
      expect(prompt).toContain('CSV');
      expect(prompt).toContain('type,id,classification,confidence,reason');
    });

    it('buildEntryPointUserPrompt formats candidates correctly', () => {
      const candidates: EntryPointCandidate[] = [
        {
          id: 42,
          name: 'UserController',
          kind: 'class',
          filePath: '/project/controllers/user.controller.ts',
          incomingDeps: 5,
          outgoingDeps: 10,
          purpose: 'Handles user API requests',
          domain: ['user-management', 'auth'],
          role: 'controller',
        },
      ];

      const prompt = buildEntryPointUserPrompt(candidates);

      expect(prompt).toContain('## Entry Point Candidates (1)');
      expect(prompt).toContain('#42: UserController (class)');
      expect(prompt).toContain('Connectivity: 5 incoming, 10 outgoing');
      expect(prompt).toContain('Purpose: "Handles user API requests"');
      expect(prompt).toContain('Domains: user-management, auth');
      expect(prompt).toContain('Role: controller');
    });
  });

  describe('Flow Construction', () => {
    it('buildFlowConstructionSystemPrompt returns a non-empty prompt', () => {
      const prompt = buildFlowConstructionSystemPrompt();
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes sub-flow instructions', () => {
      const prompt = buildFlowConstructionSystemPrompt();
      expect(prompt).toContain('subflow');
      expect(prompt).toContain('Composite flows');
      expect(prompt).toContain('is_composite');
    });

    it('includes CSV format with step types', () => {
      const prompt = buildFlowConstructionSystemPrompt();
      expect(prompt).toContain('type,flow_id,field,value');
      expect(prompt).toContain('step,');
      expect(prompt).toContain('subflow:');
      expect(prompt).toContain('subflow_reason');
    });

    it('buildFlowConstructionUserPrompt formats contexts correctly', () => {
      const contexts: FlowConstructionContext[] = [
        {
          entryPoint: {
            id: 42,
            name: 'UserController',
            kind: 'class',
            filePath: '/project/controllers/user.controller.ts',
            line: 10,
            endLine: 100,
            isExported: true,
            purpose: 'Handles user requests',
            domain: ['user'],
            role: 'controller',
          },
          neighborhood: {
            nodes: [
              {
                id: 42,
                name: 'UserController',
                kind: 'class',
                filePath: '/project/controllers/user.controller.ts',
                line: 10,
                endLine: 100,
                isExported: true,
                purpose: 'Handles user requests',
                domain: ['user'],
                role: 'controller',
              },
              {
                id: 43,
                name: 'UserService',
                kind: 'class',
                filePath: '/project/services/user.service.ts',
                line: 5,
                endLine: 50,
                isExported: true,
                purpose: 'User business logic',
                domain: ['user'],
                role: 'service',
              },
            ],
            edges: [
              {
                fromId: 42,
                toId: 43,
                weight: 3,
                semantic: 'delegates user operations to service layer',
              },
            ],
          },
          existingFlows: [],
          existingSubflows: ['ValidateUser'],
        },
      ];

      const prompt = buildFlowConstructionUserPrompt(contexts);

      expect(prompt).toContain('## Available Sub-flows');
      expect(prompt).toContain('ValidateUser');
      expect(prompt).toContain('### Flow 1: Entry Point #42 - UserController');
      expect(prompt).toContain('**Call Graph Neighborhood:**');
      expect(prompt).toContain('#42: UserController (class) [controller]');
      expect(prompt).toContain('**Call Relationships:**');
      expect(prompt).toContain('UserController (#42) → UserService (#43)');
      expect(prompt).toContain('delegates user operations to service layer');
    });
  });

  describe('Gap Filling', () => {
    it('buildGapFillingSystemPrompt returns a non-empty prompt', () => {
      const prompt = buildGapFillingSystemPrompt();
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('includes suggestion types', () => {
      const prompt = buildGapFillingSystemPrompt();
      expect(prompt).toContain('new_flow');
      expect(prompt).toContain('add_to_existing');
      expect(prompt).toContain('new_subflow');
    });

    it('buildGapFillingUserPrompt formats context correctly', () => {
      const context: GapFillingContext = {
        uncoveredSymbols: [
          {
            id: 89,
            name: 'validatePayment',
            kind: 'function',
            filePath: '/project/utils/payment.ts',
            purpose: 'Validates payment details',
            domain: ['payments'],
            role: 'utility',
            incomingDeps: 12,
            outgoingDeps: 3,
          },
        ],
        existingFlows: [
          {
            id: 1,
            name: 'CreateSale',
            description: 'Processes a new sale',
            stepCount: 5,
          },
        ],
        coverageStats: {
          covered: 50,
          total: 100,
          percentage: 50.0,
        },
      };

      const prompt = buildGapFillingUserPrompt(context);

      expect(prompt).toContain('## Current Coverage');
      expect(prompt).toContain('50/100 symbols covered (50.0%)');
      expect(prompt).toContain('## Existing Flows');
      expect(prompt).toContain('[1] CreateSale (5 steps): Processes a new sale');
      expect(prompt).toContain('## Uncovered Important Symbols (1)');
      expect(prompt).toContain('#89: validatePayment (function)');
      expect(prompt).toContain('Connectivity: 12 incoming, 3 outgoing');
    });
  });

  describe('Coverage Stats Formatting', () => {
    it('formats coverage stats correctly', () => {
      const stats: FlowCoverageStats = {
        totalInteractions: 100,
        coveredByFlows: 75,
        percentage: 75.0,
      };

      const formatted = formatCoverageStats(stats);

      expect(formatted).toContain('## Flow Coverage Statistics');
      expect(formatted).toContain('Total interactions: 100');
      expect(formatted).toContain('Covered by flows: 75 (75.0%)');
    });

    it('handles zero coverage', () => {
      const stats: FlowCoverageStats = {
        totalInteractions: 50,
        coveredByFlows: 0,
        percentage: 0.0,
      };

      const formatted = formatCoverageStats(stats);

      expect(formatted).toContain('Total interactions: 50');
      expect(formatted).toContain('Covered by flows: 0 (0.0%)');
    });

    it('handles 100% coverage', () => {
      const stats: FlowCoverageStats = {
        totalInteractions: 25,
        coveredByFlows: 25,
        percentage: 100.0,
      };

      const formatted = formatCoverageStats(stats);

      expect(formatted).toContain('Total interactions: 25');
      expect(formatted).toContain('Covered by flows: 25 (100.0%)');
    });
  });
});
