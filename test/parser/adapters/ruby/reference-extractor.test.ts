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

describe('constant-receiver references (Zeitwerk implicit imports)', () => {
  it('detects BookSerializer.new(book) as a reference to the serializer file', () => {
    const code = `
class BooksController < BaseController
  def index
    books = Book.all
    render json: books.map { |b| BookSerializer.new(b).as_json }
  end
end`;
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      path.join(projectRoot, 'app/controllers/books_controller.rb'),
      path.join(projectRoot, 'app/serializers/book_serializer.rb'),
      path.join(projectRoot, 'app/models/book.rb'),
    ]);
    const refs = extractRubyReferences(
      parse(code),
      path.join(projectRoot, 'app/controllers/books_controller.rb'),
      knownFiles
    );

    const bookSerializerRef = refs.find((r) => r.source === 'BookSerializer');
    expect(bookSerializerRef).toBeDefined();
    expect(bookSerializerRef!.resolvedPath).toBe(path.join(projectRoot, 'app/serializers/book_serializer.rb'));
    expect(bookSerializerRef!.isExternal).toBe(false);
    expect(bookSerializerRef!.type).toBe('import');

    // Usages must be populated for call-graph integration
    const bsUsages = bookSerializerRef!.imports[0].usages;
    expect(bsUsages.length).toBeGreaterThanOrEqual(1);
    expect(bsUsages[0].context).toBe('call');
    expect(bsUsages[0].callsite?.isConstructorCall).toBe(true);
    expect(bsUsages[0].callsite?.receiverName).toBe('BookSerializer');

    const bookRef = refs.find((r) => r.source === 'Book');
    expect(bookRef).toBeDefined();
    expect(bookRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/book.rb'));
    expect(bookRef!.imports[0].usages.length).toBeGreaterThanOrEqual(1);
  });

  it('handles class method calls: User.authenticate(...)', () => {
    const code = `
class SessionsController
  def create
    user = User.authenticate(params[:email], params[:password])
  end
end`;
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      path.join(projectRoot, 'app/controllers/sessions_controller.rb'),
      path.join(projectRoot, 'app/models/user.rb'),
    ]);
    const refs = extractRubyReferences(
      parse(code),
      path.join(projectRoot, 'app/controllers/sessions_controller.rb'),
      knownFiles
    );

    const userRef = refs.find((r) => r.source === 'User');
    expect(userRef).toBeDefined();
    expect(userRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/user.rb'));
  });

  it('deduplicates constant references within the same file', () => {
    const code = `
class OrdersController
  def index
    render json: orders.map { |o| OrderSerializer.new(o).as_json }
  end
  def show
    render json: OrderSerializer.new(@order).as_json
  end
end`;
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      path.join(projectRoot, 'app/controllers/orders_controller.rb'),
      path.join(projectRoot, 'app/serializers/order_serializer.rb'),
    ]);
    const refs = extractRubyReferences(
      parse(code),
      path.join(projectRoot, 'app/controllers/orders_controller.rb'),
      knownFiles
    );

    const orderSerializerRefs = refs.filter((r) => r.source === 'OrderSerializer');
    expect(orderSerializerRefs).toHaveLength(1);

    // Both call sites should be captured as usages on the single reference
    const usages = orderSerializerRefs[0].imports[0].usages;
    expect(usages).toHaveLength(2);
    expect(usages.every((u) => u.context === 'call')).toBe(true);
  });

  it('ignores unresolvable constants (framework classes, external gems)', () => {
    const code = `
class User < ApplicationRecord
  has_secure_password
  validates :email, presence: true
end`;
    const projectRoot = '/project';
    const knownFiles = new Set([path.join(projectRoot, 'Gemfile'), path.join(projectRoot, 'app/models/user.rb')]);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/user.rb'), knownFiles);

    // No resolved constant-receiver imports (ApplicationRecord is in the extends clause, not a call receiver)
    const resolvedImports = refs.filter((r) => !r.isExternal && r.type === 'import');
    expect(resolvedImports).toHaveLength(0);
  });

  it('does not duplicate references when include and constant-receiver call both appear', () => {
    const code = `
class Book < ApplicationRecord
  include Searchable
  def search
    Searchable.reindex(self)
  end
end`;
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      path.join(projectRoot, 'app/models/book.rb'),
      path.join(projectRoot, 'app/models/searchable.rb'),
    ]);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/book.rb'), knownFiles);

    // Should produce exactly one reference for Searchable (from include), not two
    const searchableRefs = refs.filter((r) => r.source === 'Searchable' && !r.isExternal);
    expect(searchableRefs).toHaveLength(1);
  });

  it('handles scope_resolution receivers (namespaced constants)', () => {
    const code = `
class OrdersController
  def create
    result = Admin::AuditService.log(current_user, 'order_created')
  end
end`;
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      path.join(projectRoot, 'app/controllers/orders_controller.rb'),
      path.join(projectRoot, 'app/services/admin/audit_service.rb'),
    ]);
    const refs = extractRubyReferences(
      parse(code),
      path.join(projectRoot, 'app/controllers/orders_controller.rb'),
      knownFiles
    );

    const auditRef = refs.find((r) => r.source === 'Admin::AuditService');
    expect(auditRef).toBeDefined();
    expect(auditRef!.resolvedPath).toBe(path.join(projectRoot, 'app/services/admin/audit_service.rb'));
    expect(auditRef!.imports[0].usages).toHaveLength(1);
    expect(auditRef!.imports[0].usages[0].callsite?.receiverName).toBe('Admin::AuditService');
  });
});

// PR3: ActiveRecord association DSLs are the primary structural signal for how
// Rails models depend on each other. Without capturing them, the symbols stage's
// LLM has zero structured signal that `class Author` depends on `Book` (the
// `has_many :books` line is in the source text but the LLM heavily discounts
// unstructured source). Capturing them as constant references — and emitting
// usages so the call-graph picks them up — populates EnhancedSymbol.dependencies.
describe('Rails ActiveRecord associations', () => {
  function railsKnownFiles(modelNames: string[]): { projectRoot: string; knownFiles: Set<string> } {
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      ...modelNames.map((n) => path.join(projectRoot, `app/models/${n}.rb`)),
    ]);
    return { projectRoot, knownFiles };
  }

  it('extracts has_many :books in a class body as a reference to Book', () => {
    const code = `
      class Author < ApplicationRecord
        has_many :books
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['author', 'book', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/author.rb'), knownFiles);

    const bookRef = refs.find((r) => r.source === 'Book');
    expect(bookRef).toBeDefined();
    expect(bookRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/book.rb'));
    expect(bookRef!.isExternal).toBe(false);
    expect(bookRef!.imports[0].usages.length).toBeGreaterThan(0);
  });

  it('extracts belongs_to :author as a reference to Author', () => {
    const code = `
      class Book < ApplicationRecord
        belongs_to :author
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['author', 'book', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/book.rb'), knownFiles);

    const authorRef = refs.find((r) => r.source === 'Author');
    expect(authorRef).toBeDefined();
    expect(authorRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/author.rb'));
  });

  it('extracts has_one :profile as a reference to Profile', () => {
    const code = `
      class User < ApplicationRecord
        has_one :profile
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['user', 'profile', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/user.rb'), knownFiles);

    const profileRef = refs.find((r) => r.source === 'Profile');
    expect(profileRef).toBeDefined();
    expect(profileRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/profile.rb'));
  });

  it('extracts has_and_belongs_to_many :tags as a reference to Tag', () => {
    const code = `
      class Article < ApplicationRecord
        has_and_belongs_to_many :tags
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['article', 'tag', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/article.rb'), knownFiles);

    const tagRef = refs.find((r) => r.source === 'Tag');
    expect(tagRef).toBeDefined();
    expect(tagRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/tag.rb'));
  });

  it('respects class_name: option override', () => {
    const code = `
      class Article < ApplicationRecord
        belongs_to :writer, class_name: 'Author'
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['article', 'author', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/article.rb'), knownFiles);

    const authorRef = refs.find((r) => r.source === 'Author');
    expect(authorRef).toBeDefined();
    expect(authorRef!.resolvedPath).toBe(path.join(projectRoot, 'app/models/author.rb'));
    // The :writer symbol should NOT be misresolved to a "Writer" class.
    expect(refs.find((r) => r.source === 'Writer')).toBeUndefined();
  });

  it('handles class_name: with a namespaced value', () => {
    const code = `
      class Article < ApplicationRecord
        belongs_to :writer, class_name: 'Catalog::Author'
      end
    `;
    const projectRoot = '/project';
    const knownFiles = new Set([
      path.join(projectRoot, 'Gemfile'),
      path.join(projectRoot, 'app/models/article.rb'),
      path.join(projectRoot, 'app/models/catalog/author.rb'),
    ]);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/article.rb'), knownFiles);

    const authorRef = refs.find((r) => r.source === 'Catalog::Author');
    expect(authorRef).toBeDefined();
  });

  it('handles plural irregulars (people → Person, children → Child)', () => {
    const code = `
      class Family < ApplicationRecord
        has_many :people
        has_many :children
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['family', 'person', 'child', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/family.rb'), knownFiles);

    expect(refs.find((r) => r.source === 'Person')).toBeDefined();
    expect(refs.find((r) => r.source === 'Child')).toBeDefined();
  });

  it('handles multiple associations on one class', () => {
    const code = `
      class Order < ApplicationRecord
        belongs_to :user
        has_many :order_items
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['order', 'user', 'order_item', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/order.rb'), knownFiles);

    expect(refs.find((r) => r.source === 'User')).toBeDefined();
    expect(refs.find((r) => r.source === 'OrderItem')).toBeDefined();
  });

  it('does NOT extract has_many calls inside method bodies', () => {
    const code = `
      class Author < ApplicationRecord
        def setup_books
          has_many :books  # Inside a method body, not class scope
        end
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['author', 'book', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/author.rb'), knownFiles);

    // The class-body walk should NOT pick up associations inside def bodies.
    expect(refs.find((r) => r.source === 'Book')).toBeUndefined();
  });

  it('does NOT extract has_many when arg is not a simple symbol', () => {
    const code = `
      class Author < ApplicationRecord
        SOME_LIST = %i[books]
        has_many SOME_LIST.first
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['author', 'book', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/author.rb'), knownFiles);

    // Arg is not a simple_symbol literal — we can't statically resolve, so skip.
    expect(refs.find((r) => r.source === 'Book')).toBeUndefined();
  });

  it('emits usage entry at the has_many call site for call-graph integration', () => {
    const code = `
      class Author < ApplicationRecord
        has_many :books
      end
    `;
    const { projectRoot, knownFiles } = railsKnownFiles(['author', 'book', 'application_record']);
    const refs = extractRubyReferences(parse(code), path.join(projectRoot, 'app/models/author.rb'), knownFiles);

    const bookRef = refs.find((r) => r.source === 'Book');
    expect(bookRef).toBeDefined();
    expect(bookRef!.imports[0].usages).toHaveLength(1);
    // The usage row should match the line number where `has_many :books` appears (row 2 in the snippet).
    expect(bookRef!.imports[0].usages[0].position.row).toBeGreaterThan(0);
    expect(bookRef!.imports[0].usages[0].context).toBe('call');
    expect(bookRef!.imports[0].usages[0].callsite?.isMethodCall).toBe(true);
  });
});
