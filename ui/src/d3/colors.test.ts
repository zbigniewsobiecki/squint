import { describe, it, expect } from 'vitest';
import {
  KIND_COLORS,
  HIERARCHY_COLORS,
  LAYER_COLORS,
  FLOW_COLORS,
  getFlowColor,
  getKindColor,
  getHierarchyColor,
  getStrokeColor,
  getLayerFromPath,
  getNodeRadius,
} from './colors';
import type { HierarchyNode } from '../types/api';

// Helper to create d3-like hierarchy nodes for testing
function createHierarchyNode(data: HierarchyNode): { data: HierarchyNode } {
  return { data };
}

describe('colors', () => {
  describe('KIND_COLORS', () => {
    it('has colors for common symbol kinds', () => {
      expect(KIND_COLORS.function).toBeDefined();
      expect(KIND_COLORS.class).toBeDefined();
      expect(KIND_COLORS.interface).toBeDefined();
      expect(KIND_COLORS.type).toBeDefined();
      expect(KIND_COLORS.variable).toBeDefined();
      expect(KIND_COLORS.enum).toBeDefined();
      expect(KIND_COLORS.method).toBeDefined();
    });

    it('all colors are valid hex codes', () => {
      const hexRegex = /^#[0-9a-f]{6}$/i;
      for (const color of Object.values(KIND_COLORS)) {
        expect(color).toMatch(hexRegex);
      }
    });
  });

  describe('HIERARCHY_COLORS', () => {
    it('has colors for directory and file', () => {
      expect(HIERARCHY_COLORS.directory).toBeDefined();
      expect(HIERARCHY_COLORS.file).toBeDefined();
    });
  });

  describe('LAYER_COLORS', () => {
    it('has colors for architectural layers', () => {
      expect(LAYER_COLORS.controller).toBeDefined();
      expect(LAYER_COLORS.service).toBeDefined();
      expect(LAYER_COLORS.repository).toBeDefined();
      expect(LAYER_COLORS.adapter).toBeDefined();
      expect(LAYER_COLORS.utility).toBeDefined();
      expect(LAYER_COLORS.default).toBeDefined();
    });

    it('each layer has fill and stroke colors', () => {
      for (const layer of Object.values(LAYER_COLORS)) {
        expect(layer.fill).toBeDefined();
        expect(layer.stroke).toBeDefined();
      }
    });
  });

  describe('FLOW_COLORS', () => {
    it('has multiple colors in palette', () => {
      expect(FLOW_COLORS.length).toBeGreaterThan(0);
    });

    it('all colors are valid hex codes', () => {
      const hexRegex = /^#[0-9a-f]{6}$/i;
      for (const color of FLOW_COLORS) {
        expect(color).toMatch(hexRegex);
      }
    });
  });

  describe('getFlowColor', () => {
    it('returns color for index within range', () => {
      expect(getFlowColor(0)).toBe(FLOW_COLORS[0]);
      expect(getFlowColor(1)).toBe(FLOW_COLORS[1]);
    });

    it('wraps around for index beyond palette size', () => {
      const paletteSize = FLOW_COLORS.length;
      expect(getFlowColor(paletteSize)).toBe(FLOW_COLORS[0]);
      expect(getFlowColor(paletteSize + 1)).toBe(FLOW_COLORS[1]);
      expect(getFlowColor(paletteSize * 2)).toBe(FLOW_COLORS[0]);
    });
  });

  describe('getKindColor', () => {
    it('returns color for known kinds', () => {
      expect(getKindColor('function')).toBe(KIND_COLORS.function);
      expect(getKindColor('class')).toBe(KIND_COLORS.class);
      expect(getKindColor('interface')).toBe(KIND_COLORS.interface);
    });

    it('returns default color for unknown kinds', () => {
      expect(getKindColor('unknown')).toBe('#666');
      expect(getKindColor('custom')).toBe('#666');
      expect(getKindColor('')).toBe('#666');
    });
  });

  describe('getHierarchyColor', () => {
    it('returns kind color for symbol nodes', () => {
      const node = createHierarchyNode({
        name: 'myFunction',
        data: { id: 1, name: 'myFunction', kind: 'function', filePath: 'test.ts', hasAnnotations: false, lines: 10 },
      });

      expect(getHierarchyColor(node as any)).toBe(KIND_COLORS.function);
    });

    it('returns file color for file nodes', () => {
      const node = createHierarchyNode({
        name: 'test.ts',
        isFile: true,
        children: [],
      });

      expect(getHierarchyColor(node as any)).toBe(HIERARCHY_COLORS.file);
    });

    it('returns directory color for directory nodes', () => {
      const node = createHierarchyNode({
        name: 'src',
        isDirectory: true,
        children: [],
      });

      expect(getHierarchyColor(node as any)).toBe(HIERARCHY_COLORS.directory);
    });

    it('returns default color for root or unknown nodes', () => {
      const node = createHierarchyNode({
        name: 'root',
        isRoot: true,
        children: [],
      });

      expect(getHierarchyColor(node as any)).toBe('#2d2d2d');
    });

    it('returns default for unknown kind in symbol', () => {
      const node = createHierarchyNode({
        name: 'unknown',
        data: { id: 1, name: 'unknown', kind: 'weird', filePath: 'test.ts', hasAnnotations: false, lines: 10 },
      });

      expect(getHierarchyColor(node as any)).toBe('#666');
    });
  });

  describe('getStrokeColor', () => {
    it('returns green for annotated symbols', () => {
      const node = createHierarchyNode({
        name: 'myFunction',
        data: { id: 1, name: 'myFunction', kind: 'function', filePath: 'test.ts', hasAnnotations: true, lines: 10 },
      });

      expect(getStrokeColor(node as any)).toBe('#6a9955');
    });

    it('returns default for non-annotated symbols', () => {
      const node = createHierarchyNode({
        name: 'myFunction',
        data: { id: 1, name: 'myFunction', kind: 'function', filePath: 'test.ts', hasAnnotations: false, lines: 10 },
      });

      expect(getStrokeColor(node as any)).toBe('#3c3c3c');
    });

    it('returns default for non-symbol nodes', () => {
      const node = createHierarchyNode({
        name: 'src',
        isDirectory: true,
        children: [],
      });

      expect(getStrokeColor(node as any)).toBe('#3c3c3c');
    });
  });

  describe('getLayerFromPath', () => {
    it('returns controller for controller-like paths', () => {
      expect(getLayerFromPath('src/controllers/UserController.ts')).toBe('controller');
      expect(getLayerFromPath('handlers/auth.ts')).toBe('controller');
      expect(getLayerFromPath('routes/api.ts')).toBe('controller');
    });

    it('returns service for service-like paths', () => {
      expect(getLayerFromPath('src/services/UserService.ts')).toBe('service');
      expect(getLayerFromPath('usecases/CreateUser.ts')).toBe('service');
    });

    it('returns repository for repository-like paths', () => {
      expect(getLayerFromPath('src/repositories/UserRepo.ts')).toBe('repository');
      expect(getLayerFromPath('dao/UserDAO.ts')).toBe('repository');
    });

    it('returns adapter for adapter-like paths', () => {
      expect(getLayerFromPath('adapters/PaymentAdapter.ts')).toBe('adapter');
      expect(getLayerFromPath('gateways/EmailGateway.ts')).toBe('adapter');
      expect(getLayerFromPath('clients/ApiClient.ts')).toBe('adapter');
    });

    it('returns utility for utility-like paths', () => {
      expect(getLayerFromPath('utils/string.ts')).toBe('utility');
      expect(getLayerFromPath('helpers/format.ts')).toBe('utility');
      expect(getLayerFromPath('lib/crypto.ts')).toBe('utility');
    });

    it('returns default for unrecognized paths', () => {
      expect(getLayerFromPath('src/models/User.ts')).toBe('default');
      expect(getLayerFromPath('components/Button.tsx')).toBe('default');
      expect(getLayerFromPath('index.ts')).toBe('default');
    });

    it('is case insensitive', () => {
      expect(getLayerFromPath('CONTROLLERS/User.ts')).toBe('controller');
      expect(getLayerFromPath('Services/Auth.ts')).toBe('service');
    });
  });

  describe('getNodeRadius', () => {
    it('returns minR for 0 lines', () => {
      expect(getNodeRadius(0)).toBe(5);
    });

    it('returns value close to minR for 1 line', () => {
      const radius = getNodeRadius(1);
      expect(radius).toBeGreaterThanOrEqual(5);
      // With sqrt scaling, 1 line gives sqrt(1)/sqrt(300) * 20 + 5 ≈ 6.15
      expect(radius).toBeLessThan(8);
    });

    it('returns maxR for lines >= maxLines', () => {
      expect(getNodeRadius(300)).toBe(25);
      expect(getNodeRadius(500)).toBe(25);
      expect(getNodeRadius(1000)).toBe(25);
    });

    it('returns value between minR and maxR for intermediate lines', () => {
      const radius = getNodeRadius(100);
      expect(radius).toBeGreaterThan(5);
      expect(radius).toBeLessThan(25);
    });

    it('scales non-linearly (sqrt)', () => {
      const r50 = getNodeRadius(50);
      const r100 = getNodeRadius(100);
      const r200 = getNodeRadius(200);

      // Due to sqrt scaling, doubling lines doesn't double the radius
      // Verify that all intermediate values are between minR and maxR
      expect(r50).toBeGreaterThan(5);
      expect(r50).toBeLessThan(25);
      expect(r100).toBeGreaterThan(r50);
      expect(r200).toBeGreaterThan(r100);
      // For sqrt scaling: doubling input doesn't double output
      // r100 should NOT be 2x r50 (relative to minR)
      const delta50 = r50 - 5; // normalized distance from minR
      const delta100 = r100 - 5;
      expect(delta100).toBeLessThan(2 * delta50);
    });

    it('respects custom minR and maxR', () => {
      expect(getNodeRadius(0, 10, 50)).toBe(10);
      expect(getNodeRadius(300, 10, 50, 300)).toBe(50);
    });

    it('respects custom maxLines', () => {
      // With maxLines=100, 100 lines should give maxR
      expect(getNodeRadius(100, 5, 25, 100)).toBe(25);
      // With maxLines=100, 50 lines should give intermediate value
      const radius = getNodeRadius(50, 5, 25, 100);
      expect(radius).toBeGreaterThan(5);
      expect(radius).toBeLessThan(25);
    });
  });
});
