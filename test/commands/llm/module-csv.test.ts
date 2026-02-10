import { describe, expect, it } from 'vitest';
import {
  formatCsvValue,
  isValidModulePath,
  isValidSlug,
  normalizeModulePath,
  parseAssignmentCsv,
  parseDeepenCsv,
  parseTreeCsv,
} from '../../../src/commands/llm/_shared/module-csv.js';

describe('module-csv', () => {
  // ============================================
  // normalizeModulePath
  // ============================================
  describe('normalizeModulePath', () => {
    it('passes through a clean path unchanged', () => {
      expect(normalizeModulePath('project.frontend.screens')).toBe('project.frontend.screens');
    });

    it('strips backticks', () => {
      expect(normalizeModulePath('`project.frontend.screens`')).toBe('project.frontend.screens');
    });

    it('strips surrounding double quotes', () => {
      expect(normalizeModulePath('"project.frontend.screens"')).toBe('project.frontend.screens');
    });

    it('strips surrounding single quotes', () => {
      expect(normalizeModulePath("'project.frontend.screens'")).toBe('project.frontend.screens');
    });

    it('lowercases each segment', () => {
      expect(normalizeModulePath('Project.Frontend.Screens')).toBe('project.frontend.screens');
    });

    it('replaces underscores with hyphens', () => {
      expect(normalizeModulePath('project.data_fetching.api_client')).toBe('project.data-fetching.api-client');
    });

    it('trims whitespace within segments', () => {
      expect(normalizeModulePath('project. frontend . screens ')).toBe('project.frontend.screens');
    });

    it('collapses consecutive dots (empty segments)', () => {
      expect(normalizeModulePath('project..frontend...screens')).toBe('project.frontend.screens');
    });

    it('handles combined LLM quirks', () => {
      expect(normalizeModulePath('`Project.Data_Fetching. API_Client`')).toBe('project.data-fetching.api-client');
    });

    it('handles empty string', () => {
      expect(normalizeModulePath('')).toBe('');
    });
  });

  // ============================================
  // isValidSlug
  // ============================================
  describe('isValidSlug', () => {
    it('accepts valid slugs', () => {
      expect(isValidSlug('frontend')).toBe(true);
      expect(isValidSlug('my-module')).toBe(true);
      expect(isValidSlug('a')).toBe(true);
      expect(isValidSlug('a1')).toBe(true);
      expect(isValidSlug('data-fetching')).toBe(true);
    });

    it('rejects empty slug', () => {
      expect(isValidSlug('')).toBe(false);
    });

    it('rejects slug starting with digit', () => {
      expect(isValidSlug('1abc')).toBe(false);
    });

    it('rejects slug starting with hyphen', () => {
      expect(isValidSlug('-abc')).toBe(false);
    });

    it('rejects slug with uppercase', () => {
      expect(isValidSlug('MyModule')).toBe(false);
    });

    it('rejects slug with consecutive hyphens', () => {
      expect(isValidSlug('my--module')).toBe(false);
    });

    it('rejects slug with trailing hyphen', () => {
      expect(isValidSlug('my-module-')).toBe(false);
    });

    it('rejects slug over 50 characters', () => {
      expect(isValidSlug('a'.repeat(51))).toBe(false);
    });

    it('accepts slug exactly 50 characters', () => {
      expect(isValidSlug('a'.repeat(50))).toBe(true);
    });

    it('rejects slug with special characters', () => {
      expect(isValidSlug('my_module')).toBe(false);
      expect(isValidSlug('my.module')).toBe(false);
      expect(isValidSlug('my module')).toBe(false);
    });
  });

  // ============================================
  // isValidModulePath
  // ============================================
  describe('isValidModulePath', () => {
    it('accepts valid paths', () => {
      expect(isValidModulePath('project')).toBe(true);
      expect(isValidModulePath('project.frontend')).toBe(true);
      expect(isValidModulePath('project.frontend.screens')).toBe(true);
      expect(isValidModulePath('project.backend.api.auth')).toBe(true);
    });

    it('rejects paths not starting with project', () => {
      expect(isValidModulePath('frontend.screens')).toBe(false);
      expect(isValidModulePath('other.path')).toBe(false);
    });

    it('rejects paths with invalid slugs', () => {
      expect(isValidModulePath('project.UPPER')).toBe(false);
      expect(isValidModulePath('project.my--bad')).toBe(false);
      expect(isValidModulePath('project.1start')).toBe(false);
    });

    it('rejects empty path', () => {
      expect(isValidModulePath('')).toBe(false);
    });
  });

  // ============================================
  // parseTreeCsv (Phase 1)
  // ============================================
  describe('parseTreeCsv', () => {
    it('parses valid tree CSV with is_test column', () => {
      const csv = `type,parent_path,slug,name,description,is_test
module,project,frontend,Frontend,UI components,false
module,project,backend,Backend,Server logic,false
module,project.frontend,screens,Screens,App screens,false`;
      const result = parseTreeCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.modules).toHaveLength(3);
      expect(result.modules[0]).toEqual({
        parentPath: 'project',
        slug: 'frontend',
        name: 'Frontend',
        description: 'UI components',
        isTest: false,
      });
    });

    it('parses valid legacy 5-column tree CSV', () => {
      const csv = `type,parent_path,slug,name,description
module,project,frontend,Frontend,UI components
module,project,backend,Backend,Server logic
module,project.frontend,screens,Screens,App screens`;
      const result = parseTreeCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.modules).toHaveLength(3);
      expect(result.modules[0]).toEqual({
        parentPath: 'project',
        slug: 'frontend',
        name: 'Frontend',
        description: 'UI components',
        isTest: false,
      });
    });

    it('parses is_test=true correctly', () => {
      const csv = `type,parent_path,slug,name,description,is_test
module,project,testing,Testing,Test utilities,true
module,project,frontend,Frontend,UI components,false`;
      const result = parseTreeCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.modules[0].isTest).toBe(true);
      expect(result.modules[1].isTest).toBe(false);
    });

    it('accepts flexible header: parentpath instead of parent_path', () => {
      const csv = 'type,parentpath,slug,name,description\nmodule,project,test,Test,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.modules).toHaveLength(1);
    });

    it('accepts flexible header: desc instead of description', () => {
      const csv = 'type,parent_path,slug,name,desc\nmodule,project,test,Test,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.modules).toHaveLength(1);
    });

    it('reports error on empty content', () => {
      const result = parseTreeCsv('');
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on wrong column count', () => {
      const result = parseTreeCsv('type,parent_path,slug\nmodule,project,x');
      expect(result.errors[0]).toContain('Invalid header');
    });

    it('reports error on invalid header names', () => {
      const csv = 'wrong,headers,here,now,please\nmodule,project,test,Test,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors[0]).toContain('Invalid header columns');
    });

    it('reports error on non-module type', () => {
      const csv = 'type,parent_path,slug,name,description\nother,project,test,Test,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors[0]).toContain('Unknown type "other"');
    });

    it('reports error on invalid parent_path', () => {
      const csv = 'type,parent_path,slug,name,description\nmodule,INVALID,test,Test,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors[0]).toContain('Invalid parent_path');
    });

    it('reports error on invalid slug', () => {
      const csv = 'type,parent_path,slug,name,description\nmodule,project,BAD-SLUG,Test,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors[0]).toContain('Invalid slug');
    });

    it('reports error on missing name', () => {
      const csv = 'type,parent_path,slug,name,description\nmodule,project,test,,desc';
      const result = parseTreeCsv(csv);
      expect(result.errors[0]).toContain('Missing name');
    });

    it('uses empty string for missing description', () => {
      const csv = 'type,parent_path,slug,name,description\nmodule,project,test,Test,';
      const result = parseTreeCsv(csv);
      expect(result.modules[0].description).toBe('');
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,parent_path,slug,name,description\nmodule,project,test,Test,desc\n```';
      const result = parseTreeCsv(csv);
      expect(result.modules).toHaveLength(1);
    });

    it('skips empty lines', () => {
      const csv = 'type,parent_path,slug,name,description\n\nmodule,project,test,Test,desc\n\n';
      const result = parseTreeCsv(csv);
      expect(result.modules).toHaveLength(1);
    });

    it('trims all values', () => {
      const csv = 'type,parent_path,slug,name,description\n module , project , test , Test , desc ';
      const result = parseTreeCsv(csv);
      expect(result.modules[0]).toEqual({
        parentPath: 'project',
        slug: 'test',
        name: 'Test',
        description: 'desc',
        isTest: false,
      });
    });
  });

  // ============================================
  // parseAssignmentCsv (Phase 2)
  // ============================================
  describe('parseAssignmentCsv', () => {
    it('parses valid assignments', () => {
      const csv = `type,symbol_id,module_path
assignment,42,project.frontend.screens
assignment,87,project.backend.services`;
      const result = parseAssignmentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.assignments).toHaveLength(2);
      expect(result.assignments[0]).toEqual({ symbolId: 42, modulePath: 'project.frontend.screens' });
      expect(result.assignments[1]).toEqual({ symbolId: 87, modulePath: 'project.backend.services' });
    });

    it('accepts flexible header: symbolid, modulepath', () => {
      const csv = 'type,symbolid,modulepath\nassignment,1,project.test';
      const result = parseAssignmentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.assignments).toHaveLength(1);
    });

    it('reports error on empty content', () => {
      const result = parseAssignmentCsv('');
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on wrong column count', () => {
      const result = parseAssignmentCsv('type,symbol_id\n1,2');
      expect(result.errors[0]).toContain('Invalid header row');
    });

    it('reports error on invalid header names', () => {
      const csv = 'wrong,headers,here\nassignment,1,project';
      const result = parseAssignmentCsv(csv);
      expect(result.errors[0]).toContain('Invalid header columns');
    });

    it('reports error on non-assignment type', () => {
      const csv = 'type,symbol_id,module_path\nother,1,project.test';
      const result = parseAssignmentCsv(csv);
      expect(result.errors[0]).toContain('Unknown type "other"');
    });

    it('reports error on non-numeric symbol_id', () => {
      const csv = 'type,symbol_id,module_path\nassignment,abc,project.test';
      const result = parseAssignmentCsv(csv);
      expect(result.errors[0]).toContain('Invalid symbol_id');
    });

    it('reports error on invalid module_path', () => {
      const csv = 'type,symbol_id,module_path\nassignment,1,INVALID';
      const result = parseAssignmentCsv(csv);
      expect(result.errors[0]).toContain('Invalid module_path');
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,symbol_id,module_path\nassignment,1,project.test\n```';
      const result = parseAssignmentCsv(csv);
      expect(result.assignments).toHaveLength(1);
    });

    it('skips empty lines', () => {
      const csv = 'type,symbol_id,module_path\n\nassignment,1,project.test\n\n';
      const result = parseAssignmentCsv(csv);
      expect(result.assignments).toHaveLength(1);
    });

    it('normalizes LLM-returned paths (backticks, uppercase, underscores)', () => {
      const csv = 'type,symbol_id,module_path\nassignment,1,`Project.Data_Fetching`';
      const result = parseAssignmentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0].modulePath).toBe('project.data-fetching');
    });
  });

  // ============================================
  // parseDeepenCsv (Phase 3)
  // ============================================
  describe('parseDeepenCsv', () => {
    it('parses module and reassign rows with header', () => {
      const csv = `type,parent_path,slug,name,description,definition_id
module,project.frontend.hooks,customers,Customer Hooks,Hooks for customer data,
reassign,project.frontend.hooks.customers,,,,42
reassign,project.frontend.hooks.customers,,,,43`;
      const result = parseDeepenCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.newModules).toHaveLength(1);
      expect(result.newModules[0]).toEqual({
        parentPath: 'project.frontend.hooks',
        slug: 'customers',
        name: 'Customer Hooks',
        description: 'Hooks for customer data',
      });
      expect(result.reassignments).toHaveLength(2);
      expect(result.reassignments[0]).toEqual({
        definitionId: 42,
        targetModulePath: 'project.frontend.hooks.customers',
      });
      expect(result.reassignments[1]).toEqual({
        definitionId: 43,
        targetModulePath: 'project.frontend.hooks.customers',
      });
    });

    it('auto-detects header and skips it', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nmodule,project,test,Test,desc,';
      const result = parseDeepenCsv(csv);
      expect(result.newModules).toHaveLength(1);
    });

    it('processes data starting from first row when no header', () => {
      const csv = 'module,project,test,Test,desc,';
      const result = parseDeepenCsv(csv);
      expect(result.newModules).toHaveLength(1);
    });

    it('reports error on empty content', () => {
      const result = parseDeepenCsv('');
      expect(result.errors[0]).toContain('Empty CSV content');
    });

    it('reports error on wrong column count', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nmodule,project,test,Test';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Expected 6 columns');
    });

    it('reports error on invalid parent_path for module', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nmodule,INVALID,test,Test,desc,';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Invalid parent_path');
    });

    it('reports error on invalid slug for module', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nmodule,project,BAD,Test,desc,';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Invalid slug');
    });

    it('reports error on missing name for module', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nmodule,project,test,,desc,';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Missing name');
    });

    it('uses empty string for missing description', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nmodule,project,test,Test,,';
      const result = parseDeepenCsv(csv);
      expect(result.newModules[0].description).toBe('');
    });

    it('reports error on invalid target module path for reassign', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nreassign,INVALID,,,,42';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Invalid target module path');
    });

    it('reports error on non-numeric definition_id for reassign', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nreassign,project.test,,,,abc';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Invalid definition_id');
    });

    it('reports error on unknown type', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\nunknown,project,test,Test,desc,';
      const result = parseDeepenCsv(csv);
      expect(result.errors[0]).toContain('Unknown type "unknown"');
    });

    it('strips code fences', () => {
      const csv = '```csv\ntype,parent_path,slug,name,description,definition_id\nmodule,project,test,Test,desc,\n```';
      const result = parseDeepenCsv(csv);
      expect(result.newModules).toHaveLength(1);
    });

    it('skips empty lines', () => {
      const csv = 'type,parent_path,slug,name,description,definition_id\n\nmodule,project,test,Test,desc,\n\n';
      const result = parseDeepenCsv(csv);
      expect(result.newModules).toHaveLength(1);
    });
  });

  // ============================================
  // formatCsvValue
  // ============================================
  describe('formatCsvValue', () => {
    it('returns plain values unchanged', () => {
      expect(formatCsvValue('simple')).toBe('simple');
    });

    it('quotes values with commas', () => {
      expect(formatCsvValue('a,b')).toBe('"a,b"');
    });

    it('quotes and escapes values with quotes', () => {
      expect(formatCsvValue('say "hi"')).toBe('"say ""hi"""');
    });

    it('quotes values with newlines', () => {
      expect(formatCsvValue('a\nb')).toBe('"a\nb"');
    });
  });
});
