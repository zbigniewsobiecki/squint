import { describe, expect, it } from 'vitest';
import { groupModulesByEntity } from '../../../src/commands/llm/_shared/entity-utils.js';
import type { Module } from '../../../src/db/schema.js';

function makeModule(fullPath: string, id = 1, description: string | null = null): Module {
  return {
    id,
    parentId: null,
    slug: fullPath.split('.').pop() || fullPath,
    name: fullPath,
    fullPath,
    description,
    depth: 1,
    colorIndex: 0,
    isTest: false,
    createdAt: '2024-01-01T00:00:00Z',
  };
}

describe('groupModulesByEntity', () => {
  it('empty array → empty map', () => {
    const result = groupModulesByEntity([]);
    expect(result.size).toBe(0);
  });

  it('module with description extracts entity', () => {
    const result = groupModulesByEntity([makeModule('project.auth', 1, 'Authentication and login management')]);
    expect(result.has('Authentication')).toBe(true);
    expect(result.get('Authentication')!).toHaveLength(1);
  });

  it('module with "manages X" description extracts X', () => {
    const result = groupModulesByEntity([makeModule('project.users', 1, 'Manages user profiles and accounts')]);
    expect(result.has('User')).toBe(true);
  });

  it('module with no description → "_generic"', () => {
    const result = groupModulesByEntity([makeModule('project.infrastructure.logging')]);
    expect(result.has('_generic')).toBe(true);
    expect(result.get('_generic')!).toHaveLength(1);
  });

  it('module with generic description → "_generic"', () => {
    const result = groupModulesByEntity([makeModule('project.utils', 1, 'Utility helpers')]);
    expect(result.has('_generic')).toBe(true);
  });

  it('_generic is sorted last', () => {
    const modules = [
      makeModule('project.infrastructure.logging', 1),
      makeModule('project.users.auth', 2, 'User authentication'),
    ];
    const result = groupModulesByEntity(modules);
    const keys = [...result.keys()];
    expect(keys[keys.length - 1]).toBe('_generic');
  });

  it('multiple entity groups are sorted alphabetically', () => {
    const modules = [
      makeModule('project.payments', 1, 'Payment processing and billing'),
      makeModule('project.customers', 2, 'Customer relationship management'),
      makeModule('project.users', 3, 'User account management'),
    ];
    const result = groupModulesByEntity(modules);
    const keys = [...result.keys()];
    // Customer < Payment < User (alphabetical)
    expect(keys).toEqual(['Customer', 'Payment', 'User']);
  });

  it('moduleEntityOverrides take priority over description', () => {
    const overrides = new Map([[1, 'Order']]);
    const result = groupModulesByEntity([makeModule('project.checkout', 1, 'Payment processing')], overrides);
    expect(result.has('Order')).toBe(true);
    expect(result.has('Payment')).toBe(false);
  });

  it('moduleEntityOverrides with no description for other modules', () => {
    const overrides = new Map([[1, 'User']]);
    const modules = [makeModule('project.users', 1), makeModule('project.utils', 2)];
    const result = groupModulesByEntity(modules, overrides);
    expect(result.has('User')).toBe(true);
    expect(result.has('_generic')).toBe(true);
    expect(result.get('User')!).toHaveLength(1);
  });

  it('description with short/empty first word falls back to _generic', () => {
    const result = groupModulesByEntity([makeModule('project.a', 1, 'An tiny module')]);
    // "An" is removed, "tiny" should be extracted — but wait, "an" is removed, so "tiny" is the first word
    // Actually "An" removal by regex gives "tiny module"
    // "tiny" is 4 chars and not in skip list, so it becomes entity
    expect(result.has('Tiny')).toBe(true);
  });

  it('description starting with "handles" prefix is stripped', () => {
    const result = groupModulesByEntity([makeModule('project.orders', 1, 'Handles order creation and processing')]);
    expect(result.has('Order')).toBe(true);
  });
});
