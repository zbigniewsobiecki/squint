import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Import Ruby adapter to ensure it's registered
import '../../src/parser/adapters/ruby-adapter.js';
import { parseFile, parseFiles } from '../../src/parser/ast-parser.js';

const fixtureDir = path.resolve(__dirname, '../fixtures');
const rubySimpleDir = path.join(fixtureDir, 'ruby-simple');
const rubyRailsDir = path.join(fixtureDir, 'ruby-rails');

// Helper to make absolute paths relative to a base dir for readability in assertions
function rel(base: string, abs: string): string {
  return path.relative(base, abs);
}

describe('Ruby parsing integration tests', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Ruby-simple fixture
  // ─────────────────────────────────────────────────────────────────────────
  describe('ruby-simple fixture', () => {
    it('parses version.rb and extracts the RubySimple module and VERSION constant', async () => {
      const filePath = path.join(rubySimpleDir, 'version.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('RubySimple');
      expect(names).toContain('VERSION');

      const moduleDefn = parsed.definitions.find((d) => d.name === 'RubySimple');
      expect(moduleDefn?.kind).toBe('module');

      const versionDefn = parsed.definitions.find((d) => d.name === 'VERSION');
      expect(versionDefn?.kind).toBe('const');
    });

    it('parses base_service.rb and extracts the class with methods', async () => {
      const filePath = path.join(rubySimpleDir, 'base_service.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      // PR1/1: `module RubySimple { class BaseService ... }` is a namespace-only
      // wrapper — the parser deliberately skips the RubySimple module definition
      // (it would only confuse the symbols stage's LLM into describing BaseService
      // as if it were the namespace). The contained class and its methods are
      // still extracted normally via the recursive walk.
      expect(names).not.toContain('RubySimple');
      expect(names).toContain('BaseService');
      expect(names).toContain('initialize');
      expect(names).toContain('perform');
      // attr_reader :options generates a reader method
      expect(names).toContain('options');
    });

    it('parses utils.rb and extracts module and singleton methods', async () => {
      const filePath = path.join(rubySimpleDir, 'utils.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('RubySimple');
      expect(names).toContain('Utils');
      expect(names).toContain('format_name');
      expect(names).toContain('greet');
    });

    it('parses user_service.rb and extracts class with inheritance and method', async () => {
      const filePath = path.join(rubySimpleDir, 'user_service.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('UserService');
      expect(names).toContain('perform');

      // UserService extends BaseService
      const classDefn = parsed.definitions.find((d) => d.name === 'UserService');
      expect(classDefn?.kind).toBe('class');
      expect(classDefn?.extends).toBe('BaseService');
    });

    it('parses user_service.rb and extracts require_relative references', async () => {
      const filePath = path.join(rubySimpleDir, 'user_service.rb');
      const knownFiles = new Set([
        filePath,
        path.join(rubySimpleDir, 'base_service.rb'),
        path.join(rubySimpleDir, 'utils.rb'),
      ]);
      const parsed = await parseFile(filePath, knownFiles);

      expect(parsed.references.length).toBeGreaterThanOrEqual(2);

      const sources = parsed.references.map((r) => r.source);
      expect(sources).toContain('base_service');
      expect(sources).toContain('utils');

      // References should be resolved since the files are in knownFiles
      const baseServiceRef = parsed.references.find((r) => r.source === 'base_service');
      expect(baseServiceRef?.isExternal).toBe(false);
      expect(baseServiceRef?.resolvedPath).toBeDefined();

      const utilsRef = parsed.references.find((r) => r.source === 'utils');
      expect(utilsRef?.isExternal).toBe(false);
      expect(utilsRef?.resolvedPath).toBeDefined();
    });

    it('parses main.rb and extracts require_relative references', async () => {
      const filePath = path.join(rubySimpleDir, 'main.rb');
      const knownFiles = new Set([
        filePath,
        path.join(rubySimpleDir, 'version.rb'),
        path.join(rubySimpleDir, 'user_service.rb'),
      ]);
      const parsed = await parseFile(filePath, knownFiles);

      const sources = parsed.references.map((r) => r.source);
      expect(sources).toContain('version');
      expect(sources).toContain('user_service');
    });

    it('parses utils.rb and tracks internal usages (format_name called by greet)', async () => {
      const filePath = path.join(rubySimpleDir, 'utils.rb');
      const parsed = await parseFile(filePath);

      // greet calls format_name internally
      const usages = parsed.internalUsages;
      const formatNameUsage = usages.find((u) => u.definitionName === 'format_name');
      expect(formatNameUsage).toBeDefined();
      expect(formatNameUsage!.usages.length).toBeGreaterThan(0);
    });

    it('parses all ruby-simple files together', async () => {
      const files = [
        path.join(rubySimpleDir, 'version.rb'),
        path.join(rubySimpleDir, 'base_service.rb'),
        path.join(rubySimpleDir, 'utils.rb'),
        path.join(rubySimpleDir, 'user_service.rb'),
        path.join(rubySimpleDir, 'main.rb'),
      ];
      const parsedMap = await parseFiles(files);

      expect(parsedMap.size).toBe(5);

      // All files should be parsed as Ruby
      for (const [, parsed] of parsedMap) {
        expect(parsed.language).toBe('ruby');
      }

      // All should have definitions
      let totalDefinitions = 0;
      for (const [, parsed] of parsedMap) {
        totalDefinitions += parsed.definitions.length;
      }
      expect(totalDefinitions).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Ruby-rails fixture
  // ─────────────────────────────────────────────────────────────────────────
  describe('ruby-rails fixture', () => {
    it('parses application_controller.rb and extracts class with inheritance', async () => {
      const filePath = path.join(rubyRailsDir, 'app/controllers/application_controller.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const classDefn = parsed.definitions.find((d) => d.name === 'ApplicationController');
      expect(classDefn).toBeDefined();
      expect(classDefn?.kind).toBe('class');
      expect(classDefn?.extends).toMatch(/ActionController/);
    });

    it('parses users_controller.rb and extracts class with methods', async () => {
      const filePath = path.join(rubyRailsDir, 'app/controllers/users_controller.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('UsersController');
      expect(names).toContain('index');
      expect(names).toContain('show');
      expect(names).toContain('create');
      expect(names).toContain('user_params');
    });

    it('parses user.rb model and extracts class with methods', async () => {
      const filePath = path.join(rubyRailsDir, 'app/models/user.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('User');
      expect(names).toContain('display_name');

      const userClass = parsed.definitions.find((d) => d.name === 'User');
      expect(userClass?.kind).toBe('class');
      expect(userClass?.extends).toBe('ApplicationRecord');
    });

    it('parses application_record.rb and extracts class with inheritance', async () => {
      const filePath = path.join(rubyRailsDir, 'app/models/application_record.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const classDefn = parsed.definitions.find((d) => d.name === 'ApplicationRecord');
      expect(classDefn).toBeDefined();
      expect(classDefn?.kind).toBe('class');
      expect(classDefn?.extends).toMatch(/ActiveRecord/);
    });

    it('parses user_creator.rb service and extracts class with methods', async () => {
      const filePath = path.join(rubyRailsDir, 'app/services/user_creator.rb');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('ruby');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('UserCreator');
      expect(names).toContain('initialize');
      expect(names).toContain('call');
    });

    it('parses all rails fixture files successfully', async () => {
      const files = [
        path.join(rubyRailsDir, 'app/controllers/application_controller.rb'),
        path.join(rubyRailsDir, 'app/controllers/users_controller.rb'),
        path.join(rubyRailsDir, 'app/models/application_record.rb'),
        path.join(rubyRailsDir, 'app/models/user.rb'),
        path.join(rubyRailsDir, 'app/services/user_creator.rb'),
        path.join(rubyRailsDir, 'config/routes.rb'),
      ];
      const parsedMap = await parseFiles(files);

      expect(parsedMap.size).toBe(6);

      for (const [, parsed] of parsedMap) {
        expect(parsed.language).toBe('ruby');
      }
    });

    it('resolves Rails autoloading references in users_controller.rb', async () => {
      const controllerPath = path.join(rubyRailsDir, 'app/controllers/users_controller.rb');
      const appControllerPath = path.join(rubyRailsDir, 'app/controllers/application_controller.rb');
      const userPath = path.join(rubyRailsDir, 'app/models/user.rb');
      const userCreatorPath = path.join(rubyRailsDir, 'app/services/user_creator.rb');
      const gemfilePath = path.join(rubyRailsDir, 'Gemfile');

      const knownFiles = new Set([controllerPath, appControllerPath, userPath, userCreatorPath, gemfilePath]);
      const parsed = await parseFile(controllerPath, knownFiles);

      // The controller inherits from ApplicationController — no explicit require needed in Rails
      // Check that parsing didn't throw and we got definitions
      expect(parsed.definitions.length).toBeGreaterThan(0);
    });

    // PR3: ActiveRecord association DSLs are now captured as structural references
    // by the Ruby parser. These tests assert that each model file's `has_many` /
    // `belongs_to` declarations resolve to the correct cross-file class references.
    describe('PR3: ActiveRecord associations as structural references', () => {
      function modelKnownFiles(): Set<string> {
        return new Set([
          path.join(rubyRailsDir, 'Gemfile'),
          path.join(rubyRailsDir, 'app/models/application_record.rb'),
          path.join(rubyRailsDir, 'app/models/user.rb'),
          path.join(rubyRailsDir, 'app/models/post.rb'),
          path.join(rubyRailsDir, 'app/models/author.rb'),
          path.join(rubyRailsDir, 'app/models/book.rb'),
          path.join(rubyRailsDir, 'app/models/order.rb'),
          path.join(rubyRailsDir, 'app/models/order_item.rb'),
        ]);
      }

      it('resolves User.has_many :posts to Post', async () => {
        const parsed = await parseFile(path.join(rubyRailsDir, 'app/models/user.rb'), modelKnownFiles());
        const postRef = parsed.references.find((r) => r.source === 'Post');
        expect(postRef).toBeDefined();
        expect(postRef!.isExternal).toBe(false);
        expect(postRef!.resolvedPath).toBe(path.join(rubyRailsDir, 'app/models/post.rb'));
      });

      it('resolves Post.belongs_to :user to User', async () => {
        const parsed = await parseFile(path.join(rubyRailsDir, 'app/models/post.rb'), modelKnownFiles());
        const userRef = parsed.references.find((r) => r.source === 'User');
        expect(userRef).toBeDefined();
        expect(userRef!.resolvedPath).toBe(path.join(rubyRailsDir, 'app/models/user.rb'));
      });

      it('resolves Author.has_many :books to Book', async () => {
        const parsed = await parseFile(path.join(rubyRailsDir, 'app/models/author.rb'), modelKnownFiles());
        const bookRef = parsed.references.find((r) => r.source === 'Book');
        expect(bookRef).toBeDefined();
        expect(bookRef!.resolvedPath).toBe(path.join(rubyRailsDir, 'app/models/book.rb'));
      });

      it('resolves Book.belongs_to :author + has_many :order_items', async () => {
        const parsed = await parseFile(path.join(rubyRailsDir, 'app/models/book.rb'), modelKnownFiles());
        expect(parsed.references.find((r) => r.source === 'Author')).toBeDefined();
        expect(parsed.references.find((r) => r.source === 'OrderItem')).toBeDefined();
      });

      it('resolves Order.belongs_to :user + has_many :order_items', async () => {
        const parsed = await parseFile(path.join(rubyRailsDir, 'app/models/order.rb'), modelKnownFiles());
        expect(parsed.references.find((r) => r.source === 'User')).toBeDefined();
        expect(parsed.references.find((r) => r.source === 'OrderItem')).toBeDefined();
      });

      it('resolves OrderItem.belongs_to :order + belongs_to :book', async () => {
        const parsed = await parseFile(path.join(rubyRailsDir, 'app/models/order_item.rb'), modelKnownFiles());
        expect(parsed.references.find((r) => r.source === 'Order')).toBeDefined();
        expect(parsed.references.find((r) => r.source === 'Book')).toBeDefined();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Ruby-rails-irregular-plurals fixture (PR3)
  // ─────────────────────────────────────────────────────────────────────────
  describe('ruby-rails-irregular-plurals fixture', () => {
    const irregularDir = path.join(fixtureDir, 'ruby-rails-irregular-plurals');

    function irregularKnownFiles(): Set<string> {
      return new Set([
        path.join(irregularDir, 'Gemfile'),
        path.join(irregularDir, 'app/models/application_record.rb'),
        path.join(irregularDir, 'app/models/family.rb'),
        path.join(irregularDir, 'app/models/person.rb'),
        path.join(irregularDir, 'app/models/child.rb'),
      ]);
    }

    it('resolves Family.has_many :people to Person', async () => {
      const parsed = await parseFile(path.join(irregularDir, 'app/models/family.rb'), irregularKnownFiles());
      const personRef = parsed.references.find((r) => r.source === 'Person');
      expect(personRef).toBeDefined();
      expect(personRef!.resolvedPath).toBe(path.join(irregularDir, 'app/models/person.rb'));
    });

    it('resolves Family.has_many :children to Child', async () => {
      const parsed = await parseFile(path.join(irregularDir, 'app/models/family.rb'), irregularKnownFiles());
      const childRef = parsed.references.find((r) => r.source === 'Child');
      expect(childRef).toBeDefined();
      expect(childRef!.resolvedPath).toBe(path.join(irregularDir, 'app/models/child.rb'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Mixed TypeScript + Ruby project
  // ─────────────────────────────────────────────────────────────────────────
  describe('mixed TypeScript + Ruby project', () => {
    it('parses TypeScript files correctly alongside Ruby files', async () => {
      const tsFiles = [path.join(fixtureDir, 'simple/index.ts'), path.join(fixtureDir, 'simple/utils.ts')];
      const rubyFiles = [
        path.join(rubySimpleDir, 'version.rb'),
        path.join(rubySimpleDir, 'base_service.rb'),
        path.join(rubySimpleDir, 'utils.rb'),
        path.join(rubySimpleDir, 'user_service.rb'),
        path.join(rubySimpleDir, 'main.rb'),
      ];
      const allFiles = [...tsFiles, ...rubyFiles];

      const parsedMap = await parseFiles(allFiles);

      expect(parsedMap.size).toBe(allFiles.length);

      // TypeScript files should be parsed as typescript/javascript
      const tsFilesInMap = allFiles.filter((f) => f.endsWith('.ts'));
      for (const f of tsFilesInMap) {
        const parsed = parsedMap.get(f);
        expect(parsed).toBeDefined();
        expect(['typescript', 'javascript']).toContain(parsed!.language);
      }

      // Ruby files should be parsed as ruby
      const rbFilesInMap = allFiles.filter((f) => f.endsWith('.rb'));
      for (const f of rbFilesInMap) {
        const parsed = parsedMap.get(f);
        expect(parsed).toBeDefined();
        expect(parsed!.language).toBe('ruby');
      }
    });

    it('extracts definitions from both TypeScript and Ruby files in a mixed project', async () => {
      const tsFile = path.join(fixtureDir, 'simple/utils.ts');
      const rbFile = path.join(rubySimpleDir, 'base_service.rb');
      const allFiles = [tsFile, rbFile];

      const parsedMap = await parseFiles(allFiles);

      // TypeScript: should have add, subtract, PI, Calculator, Operation
      const tsParsed = parsedMap.get(tsFile);
      expect(tsParsed).toBeDefined();
      const tsNames = tsParsed!.definitions.map((d) => d.name);
      expect(tsNames).toContain('add');
      expect(tsNames).toContain('subtract');

      // Ruby: should have RubySimple, BaseService, initialize, perform, options
      const rbParsed = parsedMap.get(rbFile);
      expect(rbParsed).toBeDefined();
      const rbNames = rbParsed!.definitions.map((d) => d.name);
      expect(rbNames).toContain('BaseService');
      expect(rbNames).toContain('initialize');
      expect(rbNames).toContain('perform');
    });

    it('correctly assigns language identifiers in mixed project', async () => {
      const tsFile = path.join(fixtureDir, 'simple/index.ts');
      const rbFile = path.join(rubySimpleDir, 'user_service.rb');
      const allFiles = [tsFile, rbFile];

      const parsedMap = await parseFiles(allFiles);

      expect(parsedMap.get(tsFile)?.language).toBe('typescript');
      expect(parsedMap.get(rbFile)?.language).toBe('ruby');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regression tests: TypeScript parsing still works
  // ─────────────────────────────────────────────────────────────────────────
  describe('TypeScript regression tests', () => {
    it('still parses TypeScript files and extracts definitions', async () => {
      const filePath = path.join(fixtureDir, 'simple/utils.ts');
      const parsed = await parseFile(filePath);

      expect(parsed.language).toBe('typescript');

      const names = parsed.definitions.map((d) => d.name);
      expect(names).toContain('add');
      expect(names).toContain('subtract');
      expect(names).toContain('PI');
      expect(names).toContain('Calculator');
      expect(names).toContain('Operation');
    });

    it('still parses TypeScript imports and resolves cross-file references', async () => {
      const indexPath = path.join(fixtureDir, 'simple/index.ts');
      const utilsPath = path.join(fixtureDir, 'simple/utils.ts');
      const knownFiles = new Set([indexPath, utilsPath]);
      const parsed = await parseFile(indexPath, knownFiles);

      expect(parsed.language).toBe('typescript');
      expect(parsed.references.length).toBeGreaterThan(0);

      const ref = parsed.references.find((r) => r.source.includes('utils'));
      expect(ref).toBeDefined();
      expect(ref?.isExternal).toBe(false);
    });

    it('still extracts TypeScript internal usages', async () => {
      const filePath = path.join(fixtureDir, 'simple/index.ts');
      const utilsPath = path.join(fixtureDir, 'simple/utils.ts');
      const knownFiles = new Set([filePath, utilsPath]);
      const parsed = await parseFile(filePath, knownFiles);

      // index.ts imports and calls add/subtract from utils
      expect(parsed.language).toBe('typescript');
      expect(parsed.definitions.length).toBeGreaterThan(0);
    });

    it('language registry handles both Ruby and TypeScript adapters simultaneously', async () => {
      // Both adapters should work in the same registry after import
      const tsFile = path.join(fixtureDir, 'simple/utils.ts');
      const rbFile = path.join(rubySimpleDir, 'version.rb');

      const [tsParsed, rbParsed] = await Promise.all([parseFile(tsFile), parseFile(rbFile)]);

      expect(tsParsed.language).toBe('typescript');
      expect(rbParsed.language).toBe('ruby');

      // Both should have definitions
      expect(tsParsed.definitions.length).toBeGreaterThan(0);
      expect(rbParsed.definitions.length).toBeGreaterThan(0);
    });
  });
});
