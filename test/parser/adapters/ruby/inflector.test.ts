import { describe, expect, it } from 'vitest';
import { camelize, inferAssociationClass, singularize } from '../../../../src/parser/adapters/ruby/inflector.js';

describe('Ruby inflector', () => {
  describe('singularize', () => {
    it('drops trailing s for regular plurals', () => {
      expect(singularize('books')).toBe('book');
    });

    it('handles snake_case plurals', () => {
      expect(singularize('order_items')).toBe('order_item');
    });

    it('handles -es plurals', () => {
      expect(singularize('addresses')).toBe('address');
    });

    it('handles irregular plural: people', () => {
      expect(singularize('people')).toBe('person');
    });

    it('handles irregular plural: children', () => {
      expect(singularize('children')).toBe('child');
    });

    it('handles -ices plurals (matrices, indices)', () => {
      expect(singularize('matrices')).toBe('matrix');
      expect(singularize('indices')).toBe('index');
    });

    it('handles classical -i plurals (cacti, fungi)', () => {
      expect(singularize('cacti')).toBe('cactus');
      expect(singularize('fungi')).toBe('fungus');
    });

    it('is idempotent on already-singular words', () => {
      expect(singularize('book')).toBe('book');
    });
  });

  describe('camelize', () => {
    it('capitalizes a single snake_case token', () => {
      expect(camelize('book')).toBe('Book');
    });

    it('camelizes snake_case across multiple tokens', () => {
      expect(camelize('order_item')).toBe('OrderItem');
      expect(camelize('user_account')).toBe('UserAccount');
    });

    it('converts slash-namespace input to colon-namespace output', () => {
      expect(camelize('catalog/author')).toBe('Catalog::Author');
    });

    it('preserves colon-namespace input idempotently', () => {
      expect(camelize('catalog::author')).toBe('Catalog::Author');
    });

    it('camelizes each segment of a namespaced name', () => {
      expect(camelize('admin/user_account')).toBe('Admin::UserAccount');
    });
  });

  describe('inferAssociationClass', () => {
    it('singularizes and camelizes for has_many', () => {
      expect(inferAssociationClass('books', 'has_many')).toBe('Book');
      expect(inferAssociationClass('order_items', 'has_many')).toBe('OrderItem');
    });

    it('camelizes without singularizing for belongs_to', () => {
      expect(inferAssociationClass('user', 'belongs_to')).toBe('User');
      expect(inferAssociationClass('author', 'belongs_to')).toBe('Author');
    });

    it('camelizes without singularizing for has_one', () => {
      expect(inferAssociationClass('profile', 'has_one')).toBe('Profile');
    });

    it('singularizes and camelizes for has_and_belongs_to_many', () => {
      expect(inferAssociationClass('tags', 'has_and_belongs_to_many')).toBe('Tag');
    });

    it('handles irregular plurals', () => {
      expect(inferAssociationClass('people', 'has_many')).toBe('Person');
      expect(inferAssociationClass('children', 'has_many')).toBe('Child');
    });
  });
});
