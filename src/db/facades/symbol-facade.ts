/**
 * SymbolFacade - Focused facade for symbol/definition operations.
 * Used by code analysis commands that work with definitions, metadata, and relationships.
 */

import type { IndexDatabase } from '../database-facade.js';
import type {
  DependencyInfo,
  DependencyWithMetadata,
  EnhancedRelationshipContext,
  IncomingDependency,
  RelationshipAnnotation,
  RelationshipType,
  RelationshipWithDetails,
} from '../schema.js';

/**
 * Interface for symbol-related operations.
 * Commands can depend on this interface instead of the full IndexDatabase.
 */
export interface ISymbolFacade {
  // Definition queries
  getDefinitionById(id: number): ReturnType<IndexDatabase['definitions']['getById']>;
  getDefinitionsByName(name: string): ReturnType<IndexDatabase['definitions']['getAllByName']>;
  getAllDefinitions(filters?: { kind?: string; exported?: boolean }): ReturnType<
    IndexDatabase['definitions']['getAll']
  >;
  getDefinitionsForFile(fileId: number): ReturnType<IndexDatabase['definitions']['getForFile']>;
  getDefinitionCount(): number;

  // Metadata operations
  setDefinitionMetadata(definitionId: number, key: string, value: string): void;
  getDefinitionMetadata(definitionId: number): Record<string, string>;
  getDefinitionMetadataValue(definitionId: number, key: string): string | null;
  getDefinitionsWithMetadata(key: string): number[];
  getDefinitionsWithoutMetadata(key: string): number[];
  getAspectCoverage(filters?: { kind?: string; filePattern?: string }): ReturnType<
    IndexDatabase['metadata']['getAspectCoverage']
  >;

  // Dependency queries
  getDefinitionDependencies(definitionId: number): DependencyInfo[];
  getDependenciesWithMetadata(definitionId: number, aspect?: string): DependencyWithMetadata[];
  getIncomingDependencies(definitionId: number, limit?: number): IncomingDependency[];
  getIncomingDependencyCount(definitionId: number): number;
  getReadySymbols(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string }
  ): ReturnType<IndexDatabase['dependencies']['getReadySymbols']>;

  // Relationship operations
  setRelationshipAnnotation(
    fromDefinitionId: number,
    toDefinitionId: number,
    semantic: string,
    relationshipType?: RelationshipType
  ): void;
  getRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): RelationshipAnnotation | null;
  getAllRelationshipAnnotations(options?: { limit?: number }): RelationshipWithDetails[];
  getRelationshipsFrom(fromDefinitionId: number): RelationshipWithDetails[];
  getRelationshipsTo(toDefinitionId: number): RelationshipWithDetails[];
  getUnannotatedRelationships(options?: { limit?: number; fromDefinitionId?: number }): ReturnType<
    IndexDatabase['relationships']['getUnannotated']
  >;
  getNextRelationshipToAnnotate(options?: { limit?: number; fromDefinitionId?: number }): EnhancedRelationshipContext[];
}

/**
 * SymbolFacade implementation that wraps IndexDatabase.
 */
export class SymbolFacade implements ISymbolFacade {
  constructor(private readonly db: IndexDatabase) {}

  // Definition queries
  getDefinitionById(id: number) {
    return this.db.getDefinitionById(id);
  }

  getDefinitionsByName(name: string) {
    return this.db.getDefinitionsByName(name);
  }

  getAllDefinitions(filters?: { kind?: string; exported?: boolean }) {
    return this.db.getAllDefinitions(filters);
  }

  getDefinitionsForFile(fileId: number) {
    return this.db.getDefinitionsForFile(fileId);
  }

  getDefinitionCount(): number {
    return this.db.getDefinitionCount();
  }

  // Metadata operations
  setDefinitionMetadata(definitionId: number, key: string, value: string): void {
    this.db.setDefinitionMetadata(definitionId, key, value);
  }

  getDefinitionMetadata(definitionId: number): Record<string, string> {
    return this.db.getDefinitionMetadata(definitionId);
  }

  getDefinitionMetadataValue(definitionId: number, key: string): string | null {
    return this.db.getDefinitionMetadataValue(definitionId, key);
  }

  getDefinitionsWithMetadata(key: string): number[] {
    return this.db.getDefinitionsWithMetadata(key);
  }

  getDefinitionsWithoutMetadata(key: string): number[] {
    return this.db.getDefinitionsWithoutMetadata(key);
  }

  getAspectCoverage(filters?: { kind?: string; filePattern?: string }) {
    return this.db.getAspectCoverage(filters);
  }

  // Dependency queries
  getDefinitionDependencies(definitionId: number): DependencyInfo[] {
    return this.db.getDefinitionDependencies(definitionId);
  }

  getDependenciesWithMetadata(definitionId: number, aspect?: string): DependencyWithMetadata[] {
    return this.db.getDependenciesWithMetadata(definitionId, aspect);
  }

  getIncomingDependencies(definitionId: number, limit?: number): IncomingDependency[] {
    return this.db.getIncomingDependencies(definitionId, limit);
  }

  getIncomingDependencyCount(definitionId: number): number {
    return this.db.getIncomingDependencyCount(definitionId);
  }

  getReadySymbols(aspect: string, options?: { limit?: number; kind?: string; filePattern?: string }) {
    return this.db.getReadySymbols(aspect, options);
  }

  // Relationship operations
  setRelationshipAnnotation(
    fromDefinitionId: number,
    toDefinitionId: number,
    semantic: string,
    relationshipType: RelationshipType = 'uses'
  ): void {
    this.db.setRelationshipAnnotation(fromDefinitionId, toDefinitionId, semantic, relationshipType);
  }

  getRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): RelationshipAnnotation | null {
    return this.db.getRelationshipAnnotation(fromDefinitionId, toDefinitionId);
  }

  getAllRelationshipAnnotations(options?: { limit?: number }): RelationshipWithDetails[] {
    return this.db.getAllRelationshipAnnotations(options);
  }

  getRelationshipsFrom(fromDefinitionId: number): RelationshipWithDetails[] {
    return this.db.getRelationshipsFrom(fromDefinitionId);
  }

  getRelationshipsTo(toDefinitionId: number): RelationshipWithDetails[] {
    return this.db.getRelationshipsTo(toDefinitionId);
  }

  getUnannotatedRelationships(options?: { limit?: number; fromDefinitionId?: number }) {
    return this.db.getUnannotatedRelationships(options);
  }

  getNextRelationshipToAnnotate(options?: {
    limit?: number;
    fromDefinitionId?: number;
  }): EnhancedRelationshipContext[] {
    return this.db.getNextRelationshipToAnnotate(options);
  }
}
