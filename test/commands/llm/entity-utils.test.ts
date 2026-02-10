import { describe, expect, it } from 'vitest';
import { groupModulesByEntity } from '../../../src/commands/llm/_shared/entity-utils.js';
import type { Module } from '../../../src/db/schema.js';

function makeModule(fullPath: string, id = 1): Module {
  return {
    id,
    parentId: null,
    slug: fullPath.split('.').pop() || fullPath,
    name: fullPath,
    fullPath,
    description: null,
    depth: 1,
    colorIndex: 0,
    isTest: false,
  };
}

describe('groupModulesByEntity', () => {
  it('empty array → empty map', () => {
    const result = groupModulesByEntity([]);
    expect(result.size).toBe(0);
  });

  it('module matching .users → "User"', () => {
    const result = groupModulesByEntity([makeModule('project.users.auth')]);
    expect(result.has('User')).toBe(true);
    expect(result.get('User')!).toHaveLength(1);
  });

  it('module matching .accounts → "User"', () => {
    const result = groupModulesByEntity([makeModule('project.accounts.settings')]);
    expect(result.has('User')).toBe(true);
  });

  it('module matching .customers → "Customer"', () => {
    const result = groupModulesByEntity([makeModule('project.customers.list')]);
    expect(result.has('Customer')).toBe(true);
  });

  it('module matching .products → "Product"', () => {
    const result = groupModulesByEntity([makeModule('project.products.catalog')]);
    expect(result.has('Product')).toBe(true);
  });

  it('module matching .payments → "Payment"', () => {
    const result = groupModulesByEntity([makeModule('project.payments.checkout')]);
    expect(result.has('Payment')).toBe(true);
  });

  it('module matching no entity → "_generic"', () => {
    const result = groupModulesByEntity([makeModule('project.infrastructure.logging')]);
    expect(result.has('_generic')).toBe(true);
    expect(result.get('_generic')!).toHaveLength(1);
  });

  it('_generic is sorted last', () => {
    const modules = [makeModule('project.infrastructure.logging', 1), makeModule('project.users.auth', 2)];
    const result = groupModulesByEntity(modules);
    const keys = [...result.keys()];
    expect(keys[keys.length - 1]).toBe('_generic');
  });

  it('multiple entity groups are sorted alphabetically', () => {
    const modules = [
      makeModule('project.payments.checkout', 1),
      makeModule('project.customers.list', 2),
      makeModule('project.users.auth', 3),
    ];
    const result = groupModulesByEntity(modules);
    const keys = [...result.keys()];
    // Customer < Payment < User (alphabetical)
    expect(keys).toEqual(['Customer', 'Payment', 'User']);
  });

  it('first matching pattern wins (break)', () => {
    // .auth matches the first pattern (users/accounts/auth)
    const result = groupModulesByEntity([makeModule('project.auth.service')]);
    expect(result.has('User')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('handles plural variations (singular and plural)', () => {
    const modules = [
      makeModule('project.user.profile', 1),
      makeModule('project.users.list', 2),
      makeModule('project.account.settings', 3),
    ];
    const result = groupModulesByEntity(modules);
    // All should map to "User"
    expect(result.has('User')).toBe(true);
    expect(result.get('User')!).toHaveLength(3);
  });
});
