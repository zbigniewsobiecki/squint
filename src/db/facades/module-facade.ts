/**
 * ModuleFacade - Focused facade for module and domain operations.
 * Used by commands that organize code into modules.
 */

import type { IndexDatabase } from '../database-facade.js';
import type {
  AnnotatedSymbolInfo,
  Domain,
  DomainWithCount,
  Module,
  ModuleTreeNode,
  ModuleWithMembers,
} from '../schema.js';

/**
 * Interface for module-related operations.
 * Commands can depend on this interface instead of the full IndexDatabase.
 */
export interface IModuleFacade {
  // Module lifecycle
  ensureRootModule(): number;
  insertModule(parentId: number | null, slug: string, name: string, description?: string): number;
  clearModules(): void;

  // Module queries
  getModuleById(id: number): Module | null;
  getModuleByPath(fullPath: string): Module | null;
  getModuleChildren(moduleId: number): Module[];
  getAllModules(): Module[];
  getModuleTree(): ModuleTreeNode | null;
  getModuleCount(): number;
  getModuleStats(): ReturnType<IndexDatabase['modules']['getStats']>;

  // Module with members
  getModuleWithMembers(moduleId: number): ModuleWithMembers | null;
  getAllModulesWithMembers(): ModuleWithMembers[];
  getModulesExceedingThreshold(threshold: number): ModuleWithMembers[];

  // Symbol assignment
  assignSymbolToModule(definitionId: number, moduleId: number): void;
  getUnassignedSymbols(): AnnotatedSymbolInfo[];
  getModuleSymbols(moduleId: number): ReturnType<IndexDatabase['modules']['getSymbols']>;
  getDefinitionModule(definitionId: number): ReturnType<IndexDatabase['modules']['getDefinitionModule']>;

  // Domain operations
  addDomain(name: string, description?: string): number | null;
  getDomain(name: string): Domain | null;
  getDomainsFromRegistry(): Domain[];
  getDomainsWithCounts(): DomainWithCount[];
  getAllDomains(): string[];
  syncDomainsFromMetadata(): string[];
  getSymbolsByDomain(domain: string): ReturnType<IndexDatabase['domains']['getSymbolsByDomain']>;
}

/**
 * ModuleFacade implementation that wraps IndexDatabase.
 */
export class ModuleFacade implements IModuleFacade {
  constructor(private readonly db: IndexDatabase) {}

  // Module lifecycle
  ensureRootModule(): number {
    return this.db.ensureRootModule();
  }

  insertModule(parentId: number | null, slug: string, name: string, description?: string): number {
    return this.db.insertModule(parentId, slug, name, description);
  }

  clearModules(): void {
    this.db.clearModules();
  }

  // Module queries
  getModuleById(id: number): Module | null {
    return this.db.getModuleById(id);
  }

  getModuleByPath(fullPath: string): Module | null {
    return this.db.getModuleByPath(fullPath);
  }

  getModuleChildren(moduleId: number): Module[] {
    return this.db.getModuleChildren(moduleId);
  }

  getAllModules(): Module[] {
    return this.db.getAllModules();
  }

  getModuleTree(): ModuleTreeNode | null {
    return this.db.getModuleTree();
  }

  getModuleCount(): number {
    return this.db.getModuleCount();
  }

  getModuleStats() {
    return this.db.getModuleStats();
  }

  // Module with members
  getModuleWithMembers(moduleId: number): ModuleWithMembers | null {
    return this.db.getModuleWithMembers(moduleId);
  }

  getAllModulesWithMembers(): ModuleWithMembers[] {
    return this.db.getAllModulesWithMembers();
  }

  getModulesExceedingThreshold(threshold: number): ModuleWithMembers[] {
    return this.db.getModulesExceedingThreshold(threshold);
  }

  // Symbol assignment
  assignSymbolToModule(definitionId: number, moduleId: number): void {
    this.db.assignSymbolToModule(definitionId, moduleId);
  }

  getUnassignedSymbols(): AnnotatedSymbolInfo[] {
    return this.db.getUnassignedSymbols();
  }

  getModuleSymbols(moduleId: number) {
    return this.db.getModuleSymbols(moduleId);
  }

  getDefinitionModule(definitionId: number) {
    return this.db.getDefinitionModule(definitionId);
  }

  // Domain operations
  addDomain(name: string, description?: string): number | null {
    return this.db.addDomain(name, description);
  }

  getDomain(name: string): Domain | null {
    return this.db.getDomain(name);
  }

  getDomainsFromRegistry(): Domain[] {
    return this.db.getDomainsFromRegistry();
  }

  getDomainsWithCounts(): DomainWithCount[] {
    return this.db.getDomainsWithCounts();
  }

  getAllDomains(): string[] {
    return this.db.getAllDomains();
  }

  syncDomainsFromMetadata(): string[] {
    return this.db.syncDomainsFromMetadata();
  }

  getSymbolsByDomain(domain: string) {
    return this.db.getSymbolsByDomain(domain);
  }
}
