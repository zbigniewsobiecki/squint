import { describe, expect, it } from 'vitest';
import {
  parseEntryPointClassification,
  parseFlowConstruction,
  parseGapFillSuggestions,
} from '../../../src/commands/llm/_shared/flow-csv.js';

describe('flow-csv', () => {
  // ============================================
  // parseEntryPointClassification (Phase 1)
  // ============================================
  describe('parseEntryPointClassification', () => {
    it('parses valid entry point classifications', () => {
      const csv = `type,id,classification,confidence,reason
entry,42,top_level,high,HTTP controller
entry,87,subflow_candidate,medium,Shared validation logic`;
      const result = parseEntryPointClassification(csv);
      expect(result.errors).toEqual([]);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({
        id: 42,
        classification: 'top_level',
        confidence: 'high',
        reason: 'HTTP controller',
      });
      expect(result.entries[1]).toEqual({
        id: 87,
        classification: 'subflow_candidate',
        confidence: 'medium',
        reason: 'Shared validation logic',
      });
    });

    it('parses internal classification', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,10,internal,low,Helper function';
      const result = parseEntryPointClassification(csv);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].classification).toBe('internal');
      expect(result.entries[0].confidence).toBe('low');
    });

    it('skips non-entry rows', () => {
      const csv = 'type,id,classification,confidence,reason\nother,42,top_level,high,something';
      const result = parseEntryPointClassification(csv);
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('reports error on empty content', () => {
      const result = parseEntryPointClassification('');
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on invalid header', () => {
      const result = parseEntryPointClassification('a,b\n1,2');
      expect(result.errors[0]).toContain('columns in header');
    });

    it('reports error on invalid ID', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,abc,top_level,high,test';
      const result = parseEntryPointClassification(csv);
      expect(result.errors[0]).toContain('Invalid ID');
    });

    it('reports error on invalid classification', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,42,unknown_class,high,test';
      const result = parseEntryPointClassification(csv);
      expect(result.errors[0]).toContain('Invalid classification');
    });

    it('reports error on invalid confidence', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,42,top_level,very_high,test';
      const result = parseEntryPointClassification(csv);
      expect(result.errors[0]).toContain('Invalid confidence');
    });

    it('reports error on too few columns in row', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,42,top_level';
      const result = parseEntryPointClassification(csv);
      expect(result.errors[0]).toContain('Expected at least 5 columns');
    });

    it('skips empty lines', () => {
      const csv = 'type,id,classification,confidence,reason\n\nentry,42,top_level,high,test\n\n';
      const result = parseEntryPointClassification(csv);
      expect(result.entries).toHaveLength(1);
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,id,classification,confidence,reason\nentry,1,top_level,high,test\n```';
      const result = parseEntryPointClassification(csv);
      expect(result.entries).toHaveLength(1);
    });

    it('trims reason text', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,1,top_level,high,  spaced reason  ';
      const result = parseEntryPointClassification(csv);
      expect(result.entries[0].reason).toBe('spaced reason');
    });

    it('handles quoted reason with commas', () => {
      const csv = 'type,id,classification,confidence,reason\nentry,1,top_level,high,"handles A, B, and C"';
      const result = parseEntryPointClassification(csv);
      expect(result.entries[0].reason).toBe('handles A, B, and C');
    });
  });

  // ============================================
  // parseFlowConstruction (Phase 2)
  // ============================================
  describe('parseFlowConstruction', () => {
    it('parses a simple flow with name, description, and steps', () => {
      const csv = `type,flow_id,field,value
flow,1,name,UserRegistration
flow,1,description,Handles new user signup
step,1,1,42
step,1,2,89`;
      const result = parseFlowConstruction(csv);
      expect(result.errors).toEqual([]);
      expect(result.flows).toHaveLength(1);
      expect(result.flows[0].name).toBe('UserRegistration');
      expect(result.flows[0].description).toBe('Handles new user signup');
      expect(result.flows[0].steps).toHaveLength(2);
      expect(result.flows[0].steps[0]).toEqual({ type: 'definition', order: 1, id: 42 });
      expect(result.flows[0].steps[1]).toEqual({ type: 'definition', order: 2, id: 89 });
    });

    it('parses flow with domain', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nflow,1,domain,auth';
      const result = parseFlowConstruction(csv);
      expect(result.flows[0].domain).toBe('auth');
    });

    it('sets domain to null for empty value', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nflow,1,domain,';
      const result = parseFlowConstruction(csv);
      expect(result.flows[0].domain).toBeNull();
    });

    it('parses is_composite flag', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nflow,1,is_composite,true';
      const result = parseFlowConstruction(csv);
      expect(result.flows[0].isComposite).toBe(true);
    });

    it('parses subflow steps and auto-sets isComposite', () => {
      const csv = `type,flow_id,field,value
flow,1,name,CompositeFlow
step,1,1,42
step,1,2,subflow:ValidateUser
step,1,3,89`;
      const result = parseFlowConstruction(csv);
      expect(result.flows[0].isComposite).toBe(true);
      expect(result.flows[0].steps[1]).toEqual({ type: 'subflow', order: 2, flowName: 'ValidateUser' });
    });

    it('parses subflow_reason rows', () => {
      const csv = `type,flow_id,field,value
flow,1,name,Test
step,1,2,subflow:Validate
subflow_reason,1,2,Reusable validation logic`;
      const result = parseFlowConstruction(csv);
      expect(result.flows[0].subflowReasons.get(2)).toBe('Reusable validation logic');
    });

    it('sorts steps by order', () => {
      const csv = `type,flow_id,field,value
flow,1,name,Test
step,1,3,30
step,1,1,10
step,1,2,20`;
      const result = parseFlowConstruction(csv);
      expect(result.flows[0].steps.map((s) => s.order)).toEqual([1, 2, 3]);
    });

    it('parses multiple flows', () => {
      const csv = `type,flow_id,field,value
flow,1,name,FlowA
step,1,1,10
flow,2,name,FlowB
step,2,1,20`;
      const result = parseFlowConstruction(csv);
      expect(result.flows).toHaveLength(2);
      expect(result.flows[0].name).toBe('FlowA');
      expect(result.flows[1].name).toBe('FlowB');
    });

    it('filters out flows with empty name', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,\nstep,1,1,42';
      const result = parseFlowConstruction(csv);
      expect(result.flows).toHaveLength(0);
    });

    it('reports error on empty content', () => {
      const result = parseFlowConstruction('');
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on invalid header', () => {
      const result = parseFlowConstruction('a,b\n1,2');
      expect(result.errors[0]).toContain('Invalid header');
    });

    it('reports error on invalid flow_id', () => {
      const csv = 'type,flow_id,field,value\nflow,abc,name,Test';
      const result = parseFlowConstruction(csv);
      expect(result.errors[0]).toContain('Invalid flow_id');
    });

    it('reports error on invalid step order', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nstep,1,abc,42';
      const result = parseFlowConstruction(csv);
      expect(result.errors[0]).toContain('Invalid step order');
    });

    it('reports error on invalid step definition ID', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nstep,1,1,abc';
      const result = parseFlowConstruction(csv);
      expect(result.errors[0]).toContain('Invalid step definition ID');
    });

    it('reports error on unknown flow field', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nflow,1,unknown_field,val';
      const result = parseFlowConstruction(csv);
      expect(result.errors[0]).toContain('Unknown flow field');
    });

    it('reports error on unknown row type', () => {
      const csv = 'type,flow_id,field,value\ninvalid_type,1,name,Test';
      const result = parseFlowConstruction(csv);
      expect(result.errors[0]).toContain('Unknown row type');
    });

    it('reports error on invalid subflow_reason step order', () => {
      const csv = 'type,flow_id,field,value\nflow,1,name,Test\nsubflow_reason,1,abc,reason text';
      const result = parseFlowConstruction(csv);
      expect(result.errors[0]).toContain('Invalid step order for subflow_reason');
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,flow_id,field,value\nflow,1,name,Test\n```';
      const result = parseFlowConstruction(csv);
      expect(result.flows).toHaveLength(1);
    });
  });

  // ============================================
  // parseGapFillSuggestions (Phase 3)
  // ============================================
  describe('parseGapFillSuggestions', () => {
    it('parses new_flow suggestion', () => {
      const csv = `type,symbol_id,target_flow_id,reason
new_flow,89,,Payment validation should be standalone`;
      const result = parseGapFillSuggestions(csv);
      expect(result.errors).toEqual([]);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toEqual({
        type: 'new_flow',
        symbolId: 89,
        targetFlowId: undefined,
        reason: 'Payment validation should be standalone',
      });
    });

    it('parses add_to_existing suggestion', () => {
      const csv = `type,symbol_id,target_flow_id,reason
add_to_existing,156,3,Should be added to CreateSale flow`;
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions[0]).toEqual({
        type: 'add_to_existing',
        symbolId: 156,
        targetFlowId: 3,
        reason: 'Should be added to CreateSale flow',
      });
    });

    it('parses new_subflow suggestion', () => {
      const csv = `type,symbol_id,target_flow_id,reason
new_subflow,42,,Appears in multiple flows`;
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions[0].type).toBe('new_subflow');
    });

    it('parses multiple suggestions', () => {
      const csv = `type,symbol_id,target_flow_id,reason
new_flow,1,,reason 1
add_to_existing,2,5,reason 2
new_subflow,3,,reason 3`;
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions).toHaveLength(3);
    });

    it('reports error on invalid type', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\nunknown,1,,test';
      const result = parseGapFillSuggestions(csv);
      expect(result.errors[0]).toContain('Invalid suggestion type');
    });

    it('reports error on invalid symbol_id', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\nnew_flow,abc,,test';
      const result = parseGapFillSuggestions(csv);
      expect(result.errors[0]).toContain('Invalid symbol_id');
    });

    it('reports error when add_to_existing has no target_flow_id', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\nadd_to_existing,42,,test';
      const result = parseGapFillSuggestions(csv);
      expect(result.errors[0]).toContain('add_to_existing requires valid target_flow_id');
    });

    it('reports error on too few columns', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\nnew_flow,42';
      const result = parseGapFillSuggestions(csv);
      expect(result.errors[0]).toContain('Expected at least 4 columns');
    });

    it('returns empty for empty content', () => {
      const result = parseGapFillSuggestions('');
      expect(result.suggestions).toEqual([]);
    });

    it('skips empty lines', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\n\nnew_flow,1,,test\n\n';
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions).toHaveLength(1);
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,symbol_id,target_flow_id,reason\nnew_flow,1,,test\n```';
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions).toHaveLength(1);
    });

    it('trims reason text', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\nnew_flow,1,,  spaced reason  ';
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions[0].reason).toBe('spaced reason');
    });

    it('new_flow and new_subflow set targetFlowId to undefined', () => {
      const csv = 'type,symbol_id,target_flow_id,reason\nnew_flow,1,,test\nnew_subflow,2,,test2';
      const result = parseGapFillSuggestions(csv);
      expect(result.suggestions[0].targetFlowId).toBeUndefined();
      expect(result.suggestions[1].targetFlowId).toBeUndefined();
    });
  });
});
