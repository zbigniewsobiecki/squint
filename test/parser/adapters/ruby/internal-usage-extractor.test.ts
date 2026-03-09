import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';
import { describe, expect, it } from 'vitest';
import { extractRubyInternalUsages } from '../../../../src/parser/adapters/ruby/reference-extractor.js';
import type { Definition } from '../../../../src/parser/definition-extractor.js';

const parser = new Parser();
parser.setLanguage(Ruby);

function parse(code: string) {
  return parser.parse(code).rootNode;
}

/**
 * Helper to build a minimal Definition for a method.
 */
function methodDef(name: string, row: number, column = 0): Definition {
  return {
    name,
    kind: 'method',
    isExported: true,
    isDefault: false,
    position: { row, column },
    endPosition: { row: row + 1, column: 0 },
    declarationEndPosition: { row: row + 1, column: 0 },
  };
}

describe('extractRubyInternalUsages', () => {
  describe('implicit self receiver (method calls without explicit receiver)', () => {
    it('detects a simple implicit-self method call', () => {
      const code = `
class User
  def validate
    check_email
  end

  def check_email; end
end
      `.trim();
      const rootNode = parse(code);
      // check_email is at row 6 (0-indexed) — define it with approximate position
      const definitions: Definition[] = [methodDef('validate', 0), methodDef('check_email', 5)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const checkEmailUsage = usages.find((u) => u.definitionName === 'check_email');
      expect(checkEmailUsage).toBeDefined();
      expect(checkEmailUsage!.usages).toHaveLength(1);
      expect(checkEmailUsage!.usages[0].callsite).toBeDefined();
      expect(checkEmailUsage!.usages[0].callsite!.isMethodCall).toBe(false);
      expect(checkEmailUsage!.usages[0].callsite!.isConstructorCall).toBe(false);
    });

    it('detects multiple calls to the same method', () => {
      const code = `
class Validator
  def run
    check_format
    check_length
    check_format
  end

  def check_format; end
  def check_length; end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [
        methodDef('run', 0),
        methodDef('check_format', 7),
        methodDef('check_length', 8),
      ];

      const usages = extractRubyInternalUsages(rootNode, definitions);

      const formatUsage = usages.find((u) => u.definitionName === 'check_format');
      expect(formatUsage).toBeDefined();
      expect(formatUsage!.usages).toHaveLength(2);

      const lengthUsage = usages.find((u) => u.definitionName === 'check_length');
      expect(lengthUsage).toBeDefined();
      expect(lengthUsage!.usages).toHaveLength(1);
    });

    it('does not emit usages for methods that are never called internally', () => {
      const code = `
class User
  def never_called; end
  def also_never_called; end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('never_called', 0), methodDef('also_never_called', 1)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      expect(usages).toHaveLength(0);
    });

    it('does not track calls to methods not in the definitions list', () => {
      const code = `
class User
  def run
    external_service.call
    puts "done"
  end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('run', 0)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      // `external_service.call` has a receiver so it should not be tracked
      // `puts` is not in definitions so should not be tracked
      expect(usages).toHaveLength(0);
    });

    it('includes argument count in callsite metadata', () => {
      const code = `
class Processor
  def run
    process_data(input, output, options)
  end

  def process_data(a, b, c); end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('run', 0), methodDef('process_data', 5)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const usage = usages.find((u) => u.definitionName === 'process_data');
      expect(usage).toBeDefined();
      expect(usage!.usages[0].callsite!.argumentCount).toBe(3);
    });
  });

  describe('explicit self receiver', () => {
    it('detects self.method_name() calls', () => {
      const code = `
class User
  def run
    self.validate
  end

  def validate; end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('run', 0), methodDef('validate', 5)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const validateUsage = usages.find((u) => u.definitionName === 'validate');
      expect(validateUsage).toBeDefined();
      expect(validateUsage!.usages).toHaveLength(1);
      expect(validateUsage!.usages[0].callsite!.isMethodCall).toBe(true);
      expect(validateUsage!.usages[0].callsite!.receiverName).toBe('self');
    });

    it('does not track calls on other objects (non-self receivers)', () => {
      const code = `
class User
  def run
    other_object.validate
    @service.process
  end

  def validate; end
  def process; end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('run', 0), methodDef('validate', 7), methodDef('process', 8)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      // Calls with non-self receiver should NOT be tracked
      expect(usages).toHaveLength(0);
    });
  });

  describe('super calls', () => {
    it('tracks super call inside a locally-defined method', () => {
      const code = `
class Child < Parent
  def initialize
    super
  end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('initialize', 1)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const superUsage = usages.find((u) => u.definitionName === 'initialize');
      expect(superUsage).toBeDefined();
      expect(superUsage!.usages).toHaveLength(1);
      expect(superUsage!.usages[0].context).toBe('super');
      expect(superUsage!.usages[0].callsite).toBeDefined();
    });

    it('tracks super call with arguments', () => {
      const code = `
class Child < Parent
  def save(record)
    super
  end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('save', 1)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const superUsage = usages.find((u) => u.definitionName === 'save');
      expect(superUsage).toBeDefined();
      expect(superUsage!.usages[0].context).toBe('super');
    });

    it('does not track super when method is not locally defined', () => {
      const code = `
class Child < Parent
  def save(record)
    super
  end
end
      `.trim();
      const rootNode = parse(code);
      // No definitions provided — super should not be tracked
      const usages = extractRubyInternalUsages(rootNode, []);
      expect(usages).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty definitions list', () => {
      const code = `
def foo
  bar
end
      `.trim();
      const rootNode = parse(code);
      const usages = extractRubyInternalUsages(rootNode, []);
      expect(usages).toHaveLength(0);
    });

    it('returns empty array for empty file', () => {
      const rootNode = parse('');
      const usages = extractRubyInternalUsages(rootNode, []);
      expect(usages).toHaveLength(0);
    });

    it('does not track calls with non-self receiver even if method is locally defined', () => {
      const code = `
class Service
  def execute
    helper.process(data)
  end

  def process(x); end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('execute', 0), methodDef('process', 5)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      // `helper.process(data)` should not count as an internal usage of `process`
      // because the receiver is `helper`, not self
      expect(usages).toHaveLength(0);
    });

    it('handles methods in modules correctly', () => {
      const code = `
module Greetable
  def greet
    format_name
  end

  def format_name
    "Hello"
  end
end
      `.trim();
      const rootNode = parse(code);
      const definitions: Definition[] = [methodDef('greet', 1), methodDef('format_name', 5)];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const formatUsage = usages.find((u) => u.definitionName === 'format_name');
      expect(formatUsage).toBeDefined();
      expect(formatUsage!.usages).toHaveLength(1);
    });

    it('tracks calls to attr_accessor generated methods', () => {
      const code = `
class User
  attr_accessor :name

  def display
    name
  end
end
      `.trim();
      const rootNode = parse(code);
      // attr_accessor :name generates a 'name' method — include it in definitions
      const definitions: Definition[] = [
        {
          name: 'name',
          kind: 'method',
          isExported: true,
          isDefault: false,
          position: { row: 1, column: 2 },
          endPosition: { row: 1, column: 16 },
          declarationEndPosition: { row: 1, column: 16 },
        },
        methodDef('display', 3),
      ];

      const usages = extractRubyInternalUsages(rootNode, definitions);
      const nameUsage = usages.find((u) => u.definitionName === 'name');
      expect(nameUsage).toBeDefined();
    });
  });
});
