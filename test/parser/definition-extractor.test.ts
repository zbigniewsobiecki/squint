import { describe, expect, it } from 'vitest';
import { parseContent } from '../../src/parser/ast-parser.js';

describe('definition-extractor inheritance', () => {
  describe('class extends', () => {
    it('extracts parent class from extends clause', () => {
      const content = `
class Dog extends Animal {
  bark() {}
}
`;
      const filePath = '/project/dog.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const dogDef = result.definitions[0];
      expect(dogDef.name).toBe('Dog');
      expect(dogDef.kind).toBe('class');
      expect(dogDef.extends).toBe('Animal');
      expect(dogDef.implements).toBeUndefined();
      expect(dogDef.extendsAll).toBeUndefined();
    });

    it('extracts parent class from generic extends clause', () => {
      const content = `
class TypedList<T> extends BaseList<T> {
  items: T[] = [];
}
`;
      const filePath = '/project/list.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const listDef = result.definitions[0];
      expect(listDef.name).toBe('TypedList');
      expect(listDef.extends).toBe('BaseList');
    });

    it('extracts parent from class extending built-in Error', () => {
      const content = `
class CustomError extends Error {
  constructor(message: string) {
    super(message);
  }
}
`;
      const filePath = '/project/custom-error.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      expect(result.definitions[0].extends).toBe('Error');
    });

    it('extracts parent from class extending Array', () => {
      const content = `
class MyArray<T> extends Array<T> {
  first(): T | undefined { return this[0]; }
}
`;
      const filePath = '/project/my-array.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      expect(result.definitions[0].extends).toBe('Array');
    });
  });

  describe('class implements', () => {
    it('extracts single implemented interface', () => {
      const content = `
class Calc implements Calculator {
  add(a: number, b: number) { return a + b; }
}
`;
      const filePath = '/project/calc.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const calcDef = result.definitions[0];
      expect(calcDef.name).toBe('Calc');
      expect(calcDef.kind).toBe('class');
      expect(calcDef.extends).toBeUndefined();
      expect(calcDef.implements).toEqual(['Calculator']);
      expect(calcDef.extendsAll).toBeUndefined();
    });

    it('extracts multiple implemented interfaces', () => {
      const content = `
class Circle extends Shape implements Drawable, Resizable {
  draw() {}
  resize() {}
}
`;
      const filePath = '/project/circle.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const circleDef = result.definitions[0];
      expect(circleDef.name).toBe('Circle');
      expect(circleDef.kind).toBe('class');
      expect(circleDef.extends).toBe('Shape');
      expect(circleDef.implements).toEqual(['Drawable', 'Resizable']);
      expect(circleDef.extendsAll).toBeUndefined();
    });
  });

  describe('interface extends', () => {
    it('extracts single extended interface', () => {
      const content = `
interface Drawable extends Shape {
  draw(): void;
}
`;
      const filePath = '/project/drawable.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const drawableDef = result.definitions[0];
      expect(drawableDef.name).toBe('Drawable');
      expect(drawableDef.kind).toBe('interface');
      expect(drawableDef.extends).toBeUndefined();
      expect(drawableDef.implements).toBeUndefined();
      expect(drawableDef.extendsAll).toEqual(['Shape']);
    });

    it('extracts multiple extended interfaces', () => {
      const content = `
interface Combined extends A, B, C {
  combined(): void;
}
`;
      const filePath = '/project/combined.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const combinedDef = result.definitions[0];
      expect(combinedDef.name).toBe('Combined');
      expect(combinedDef.kind).toBe('interface');
      expect(combinedDef.extendsAll).toEqual(['A', 'B', 'C']);
    });

    it('extracts extended generic interfaces', () => {
      const content = `
interface Sortable<T> extends Comparable<T>, Iterable<T> {
  sort(): T[];
}
`;
      const filePath = '/project/sortable.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const sortableDef = result.definitions[0];
      expect(sortableDef.name).toBe('Sortable');
      expect(sortableDef.kind).toBe('interface');
      expect(sortableDef.extendsAll).toEqual(['Comparable', 'Iterable']);
    });
  });

  describe('no inheritance', () => {
    it('does not set inheritance fields for plain class', () => {
      const content = `
class Simple {
  value: number = 0;
}
`;
      const filePath = '/project/simple.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const simpleDef = result.definitions[0];
      expect(simpleDef.name).toBe('Simple');
      expect(simpleDef.extends).toBeUndefined();
      expect(simpleDef.implements).toBeUndefined();
      expect(simpleDef.extendsAll).toBeUndefined();
    });

    it('does not set inheritance fields for plain interface', () => {
      const content = `
interface Plain {
  value: number;
}
`;
      const filePath = '/project/plain.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const plainDef = result.definitions[0];
      expect(plainDef.name).toBe('Plain');
      expect(plainDef.extendsAll).toBeUndefined();
    });
  });

  describe('exported inheritance', () => {
    it('preserves export status with inheritance', () => {
      const content = `
export class ExportedChild extends Parent implements Interface {
  method() {}
}
`;
      const filePath = '/project/exported.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const exportedDef = result.definitions[0];
      expect(exportedDef.name).toBe('ExportedChild');
      expect(exportedDef.isExported).toBe(true);
      expect(exportedDef.extends).toBe('Parent');
      expect(exportedDef.implements).toEqual(['Interface']);
    });
  });

  describe('regression: exported class extending built-in types', () => {
    it('extracts extends from export class AppError extends Error', () => {
      const content = 'export class AppError extends Error { }';
      const filePath = '/project/error.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const errorDef = result.definitions[0];
      expect(errorDef.name).toBe('AppError');
      expect(errorDef.kind).toBe('class');
      expect(errorDef.isExported).toBe(true);
      expect(errorDef.extends).toBe('Error');
    });

    it('extracts extends from export default class', () => {
      const content = `
export default class DefaultError extends Error {
  isDefault = true;
}
`;
      const filePath = '/project/default-error.ts';
      const knownFiles = new Set<string>();
      const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

      const result = parseContent(content, filePath, knownFiles, metadata);

      expect(result.definitions).toHaveLength(1);
      const errorDef = result.definitions[0];
      expect(errorDef.isDefault).toBe(true);
      expect(errorDef.extends).toBe('Error');
    });
  });
});

describe('module-level definition ranges', () => {
  it('extends const endPosition to end of file for module-level usage capture', () => {
    const content = `import express from 'express';

const app = express();

app.use('/api', router);
app.listen(3000);
`;
    const filePath = '/project/app.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    const appDef = result.definitions.find((d) => d.name === 'app');
    expect(appDef).toBeDefined();
    expect(appDef?.kind).toBe('const');
    // Definition starts at line 2 (0-indexed)
    expect(appDef?.position.row).toBe(2);
    // endPosition should extend to end of file (line 6, 0-indexed, includes trailing newline)
    expect(appDef?.endPosition.row).toBe(6);
  });

  it('extends let endPosition to end of file', () => {
    const content = `let counter = 0;

counter++;
counter++;
`;
    const filePath = '/project/counter.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    const counterDef = result.definitions.find((d) => d.name === 'counter');
    expect(counterDef).toBeDefined();
    expect(counterDef?.kind).toBe('variable');
    expect(counterDef?.position.row).toBe(0);
    // Should extend to end of file (includes trailing newline)
    expect(counterDef?.endPosition.row).toBe(4);
  });

  it('extends exported const endPosition to end of file', () => {
    const content = `export const config = {
  port: 3000
};

console.log(config.port);
`;
    const filePath = '/project/config.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    const configDef = result.definitions.find((d) => d.name === 'config');
    expect(configDef).toBeDefined();
    expect(configDef?.isExported).toBe(true);
    // Should extend to end of file (includes trailing newline)
    expect(configDef?.endPosition.row).toBe(5);
  });

  it('handles multiple module-level variables', () => {
    const content = `const a = 1;
const b = 2;

console.log(a + b);
`;
    const filePath = '/project/vars.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    expect(result.definitions).toHaveLength(2);

    const aDef = result.definitions.find((d) => d.name === 'a');
    const bDef = result.definitions.find((d) => d.name === 'b');

    // Both should extend to end of file (includes trailing newline)
    expect(aDef?.endPosition.row).toBe(4);
    expect(bDef?.endPosition.row).toBe(4);
  });

  it('does not affect function definition ranges', () => {
    const content = `function hello() {
  return 'world';
}

hello();
`;
    const filePath = '/project/func.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    const helloDef = result.definitions.find((d) => d.name === 'hello');
    expect(helloDef).toBeDefined();
    expect(helloDef?.kind).toBe('function');
    // Function should end at its closing brace (line 2)
    expect(helloDef?.endPosition.row).toBe(2);
  });

  it('does not affect class definition ranges', () => {
    const content = `class MyClass {
  method() {}
}

new MyClass();
`;
    const filePath = '/project/class.ts';
    const knownFiles = new Set<string>();
    const metadata = { sizeBytes: content.length, modifiedAt: '2024-01-01T00:00:00.000Z' };

    const result = parseContent(content, filePath, knownFiles, metadata);

    const classDef = result.definitions.find((d) => d.name === 'MyClass');
    expect(classDef).toBeDefined();
    expect(classDef?.kind).toBe('class');
    // Class should end at its closing brace (line 2)
    expect(classDef?.endPosition.row).toBe(2);
  });
});
