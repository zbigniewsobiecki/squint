import path from 'node:path';
import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { describe, expect, it } from 'vitest';
import {
  extractRubyReferences,
  resolveRubyImportPath,
} from '../../../../src/parser/adapters/ruby/reference-extractor.js';

const parser = new Parser();
parser.setLanguage(Ruby);

function parse(code: string) {
  return parser.parse(code).rootNode;
}

describe('extractRubyReferences', () => {
  describe('require statements', () => {
    it('extracts require as external when gem not in known files', () => {
      const rootNode = parse(`require 'active_record'`);
      const references = extractRubyReferences(rootNode, '/app/models/user.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: 'active_record',
        isExternal: true,
        isTypeOnly: false,
        resolvedPath: undefined,
      });
      expect(references[0].imports).toEqual([{ name: '*', localName: '*', kind: 'side-effect', usages: [] }]);
    });

    it('extracts require with double-quoted string', () => {
      const rootNode = parse(`require "active_record"`);
      const references = extractRubyReferences(rootNode, '/app/models/user.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: 'active_record',
        isExternal: true,
      });
    });

    it('extracts require and resolves internal file from lib/', () => {
      // With Gemfile in knownFiles, findProjectRoot can detect the project root
      const projectRoot = '/project';
      const knownFiles = new Set([path.join(projectRoot, 'Gemfile'), path.join(projectRoot, 'lib/utils.rb')]);
      const rootNode = parse(`require 'utils'`);
      const references = extractRubyReferences(rootNode, path.join(projectRoot, 'app/models/user.rb'), knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: 'utils',
        isExternal: false,
        resolvedPath: path.join(projectRoot, 'lib/utils.rb'),
      });
    });

    it('records position of require statement', () => {
      const rootNode = parse(`require 'active_record'`);
      const references = extractRubyReferences(rootNode, '/app/models/user.rb', new Set());

      expect(references[0].position).toEqual({ row: 0, column: 0 });
    });

    it('extracts multiple require statements', () => {
      const rootNode = parse(
        `
require 'rails'
require 'json'
require 'csv'
      `.trim()
      );
      const references = extractRubyReferences(rootNode, '/app/models/user.rb', new Set());

      expect(references).toHaveLength(3);
      expect(references.map((r) => r.source)).toEqual(['rails', 'json', 'csv']);
    });
  });

  describe('require_relative statements', () => {
    it('extracts require_relative and resolves file path', () => {
      const knownFiles = new Set(['/project/app/models/user.rb']);
      const rootNode = parse(`require_relative '../models/user'`);
      const references = extractRubyReferences(rootNode, '/project/app/controllers/users_controller.rb', knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: '../models/user',
        isExternal: false,
        resolvedPath: '/project/app/models/user.rb',
      });
    });

    it('extracts require_relative with .rb extension already included', () => {
      const knownFiles = new Set(['/project/app/models/user.rb']);
      const rootNode = parse(`require_relative '../models/user.rb'`);
      const references = extractRubyReferences(rootNode, '/project/app/controllers/users_controller.rb', knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: '../models/user.rb',
        resolvedPath: '/project/app/models/user.rb',
        isExternal: false,
      });
    });

    it('sets resolvedPath to undefined when file not found', () => {
      const rootNode = parse(`require_relative '../models/unknown'`);
      const references = extractRubyReferences(rootNode, '/project/app/controllers/users_controller.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: '../models/unknown',
        isExternal: false,
        resolvedPath: undefined,
      });
    });

    it('extracts require_relative with same-directory path', () => {
      const knownFiles = new Set(['/project/app/models/base.rb']);
      const rootNode = parse(`require_relative 'base'`);
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'require',
        source: 'base',
        resolvedPath: '/project/app/models/base.rb',
        isExternal: false,
      });
    });
  });

  describe('include/extend/prepend statements', () => {
    it('extracts include as module reference', () => {
      const rootNode = parse(
        `
class User
  include Comparable
end
      `.trim()
      );
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'import',
        source: 'Comparable',
        isExternal: true,
        isTypeOnly: false,
      });
      expect(references[0].imports).toEqual([
        { name: 'Comparable', localName: 'Comparable', kind: 'named', usages: [] },
      ]);
    });

    it('extracts extend as module reference', () => {
      const rootNode = parse(
        `
class User
  extend ClassMethods
end
      `.trim()
      );
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'import',
        source: 'ClassMethods',
        isExternal: true,
      });
      expect(references[0].imports[0]).toMatchObject({
        name: 'ClassMethods',
        localName: 'ClassMethods',
        kind: 'named',
      });
    });

    it('extracts prepend as module reference', () => {
      const rootNode = parse(
        `
class User
  prepend Logging
end
      `.trim()
      );
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'import',
        source: 'Logging',
        isExternal: true,
      });
    });

    it('extracts top-level include/extend/prepend', () => {
      const rootNode = parse(
        `
include Comparable
extend ClassMethods
prepend Logging
      `.trim()
      );
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', new Set());

      expect(references).toHaveLength(3);
      expect(references[0]).toMatchObject({ type: 'import', source: 'Comparable' });
      expect(references[1]).toMatchObject({ type: 'import', source: 'ClassMethods' });
      expect(references[2]).toMatchObject({ type: 'import', source: 'Logging' });
    });

    it('resolves include to known file via Rails autoloading', () => {
      const projectRoot = '/project';
      const knownFiles = new Set([
        path.join(projectRoot, 'Gemfile'),
        path.join(projectRoot, 'app/models/searchable.rb'),
      ]);
      const rootNode = parse(
        `
class User
  include Searchable
end
      `.trim()
      );
      const references = extractRubyReferences(rootNode, path.join(projectRoot, 'app/models/user.rb'), knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'import',
        source: 'Searchable',
        isExternal: false,
        resolvedPath: path.join(projectRoot, 'app/models/searchable.rb'),
      });
    });

    it('handles scope_resolution in include (ActiveSupport::Concern)', () => {
      const rootNode = parse(
        `
class User
  include ActiveSupport::Concern
end
      `.trim()
      );
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', new Set());

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        type: 'import',
        source: 'ActiveSupport::Concern',
        isExternal: true,
      });
    });
  });

  describe('Rails autoloading conventions', () => {
    it('resolves Searchable constant to app/models/searchable.rb', () => {
      const projectRoot = '/project';
      const knownFiles = new Set([
        path.join(projectRoot, 'Gemfile'),
        path.join(projectRoot, 'app/models/searchable.rb'),
      ]);
      const rootNode = parse('include Searchable');
      const references = extractRubyReferences(
        rootNode,
        path.join(projectRoot, 'app/controllers/posts_controller.rb'),
        knownFiles
      );

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        source: 'Searchable',
        resolvedPath: path.join(projectRoot, 'app/models/searchable.rb'),
        isExternal: false,
      });
    });

    it('resolves UsersController constant to app/controllers/users_controller.rb', () => {
      const projectRoot = '/project';
      const knownFiles = new Set([
        path.join(projectRoot, 'Gemfile'),
        path.join(projectRoot, 'app/controllers/users_controller.rb'),
      ]);
      const rootNode = parse('include UsersController');
      const references = extractRubyReferences(rootNode, path.join(projectRoot, 'app/models/user.rb'), knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        source: 'UsersController',
        resolvedPath: path.join(projectRoot, 'app/controllers/users_controller.rb'),
        isExternal: false,
      });
    });

    it('resolves namespaced constant Admin::UsersController', () => {
      const projectRoot = '/project';
      const knownFiles = new Set([
        path.join(projectRoot, 'Gemfile'),
        path.join(projectRoot, 'app/controllers/admin/users_controller.rb'),
      ]);
      const rootNode = parse('include Admin::UsersController');
      const references = extractRubyReferences(rootNode, path.join(projectRoot, 'app/models/user.rb'), knownFiles);

      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        source: 'Admin::UsersController',
        resolvedPath: path.join(projectRoot, 'app/controllers/admin/users_controller.rb'),
        isExternal: false,
      });
    });
  });

  describe('mixed references', () => {
    it('extracts all reference types from a typical Rails model', () => {
      const projectRoot = '/project';
      const knownFiles = new Set([
        path.join(projectRoot, 'Gemfile'),
        path.join(projectRoot, 'app/models/concerns/searchable.rb'),
        path.join(projectRoot, 'lib/my_lib.rb'),
      ]);
      const code = `
require 'json'
require_relative '../../lib/my_lib'

class User < ApplicationRecord
  include Searchable

  extend ClassMethods
end
      `.trim();
      const rootNode = parse(code);
      const references = extractRubyReferences(rootNode, path.join(projectRoot, 'app/models/user.rb'), knownFiles);

      expect(references).toHaveLength(4);

      const requireRef = references.find((r) => r.source === 'json');
      expect(requireRef).toMatchObject({ type: 'require', isExternal: true });

      const requireRelRef = references.find((r) => r.source === '../../lib/my_lib');
      expect(requireRelRef).toMatchObject({
        type: 'require',
        isExternal: false,
        resolvedPath: path.join(projectRoot, 'lib/my_lib.rb'),
      });

      const includeRef = references.find((r) => r.source === 'Searchable');
      expect(includeRef).toMatchObject({ type: 'import' });

      const extendRef = references.find((r) => r.source === 'ClassMethods');
      expect(extendRef).toMatchObject({ type: 'import' });
    });

    it('handles empty file with no references', () => {
      const rootNode = parse('class User; end');
      const references = extractRubyReferences(rootNode, '/project/app/models/user.rb', new Set());
      expect(references).toHaveLength(0);
    });
  });
});

describe('resolveRubyImportPath', () => {
  it('resolves require_relative path (starts with ./)', () => {
    // ./utils resolves relative to the file's directory
    const knownFiles = new Set(['/project/app/models/utils.rb']);
    const result = resolveRubyImportPath('./utils', '/project/app/models/user.rb', knownFiles);
    expect(result).toBe('/project/app/models/utils.rb');
  });

  it('resolves require_relative path starting with ../', () => {
    // '../lib/utils' from '/project/app/models/user.rb' resolves to '/project/app/lib/utils.rb'
    const knownFiles = new Set(['/project/app/lib/utils.rb']);
    const result = resolveRubyImportPath('../lib/utils', '/project/app/models/user.rb', knownFiles);
    expect(result).toBe('/project/app/lib/utils.rb');
  });

  it('resolves require path found in lib/ with Gemfile present', () => {
    const knownFiles = new Set(['/project/Gemfile', '/project/lib/utils.rb']);
    const result = resolveRubyImportPath('utils', '/project/app/models/user.rb', knownFiles);
    expect(result).toBe('/project/lib/utils.rb');
  });

  it('returns null when file not found', () => {
    const result = resolveRubyImportPath('nonexistent', '/project/app/models/user.rb', new Set());
    expect(result).toBeNull();
  });

  it('returns null for external gem (not in known files)', () => {
    const result = resolveRubyImportPath('active_record', '/project/app/models/user.rb', new Set());
    expect(result).toBeNull();
  });
});
