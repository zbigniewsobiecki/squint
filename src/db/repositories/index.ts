// Core repositories
export { FileRepository } from './file-repository.js';
export type {
  FileDetails,
  FileInfo,
  FileWithStats,
  FileImportedBy,
  FileImport,
} from './file-repository.js';

export { DefinitionRepository } from './definition-repository.js';
export type {
  DefinitionInfo,
  DefinitionDetails,
  DefinitionListItem,
  FileDefinition,
  SymbolInfo,
  ClassHierarchyNode,
  ClassHierarchyLink,
} from './definition-repository.js';

export { MetadataRepository } from './metadata-repository.js';
export type {
  AspectCoverage,
  SymbolWithDomain,
  SymbolWithPurity,
} from './metadata-repository.js';

// Query repositories
export { DependencyRepository } from './dependency-repository.js';
export type {
  ImportGraphNode,
  ImportGraphLink,
} from './dependency-repository.js';

export { RelationshipRepository } from './relationship-repository.js';
export type {
  UnannotatedInheritance,
  UnannotatedRelationship,
} from './relationship-repository.js';

export { DomainRepository } from './domain-repository.js';

// Hierarchical repositories
export { ModuleRepository } from './module-repository.js';
export type {
  ModuleSymbol,
  ModuleMemberInfo,
  ModuleStats,
  IncomingEdge,
} from './module-repository.js';

export { ContractRepository } from './contract-repository.js';

export { InteractionRepository } from './interaction-repository.js';
export type {
  InteractionInsertOptions,
  InteractionUpdateOptions,
  InteractionStats,
} from './interaction-repository.js';

export { FlowRepository } from './flow-repository.js';
export type {
  FlowInsertOptions,
  FlowUpdateOptions,
  FlowStats,
} from './flow-repository.js';

// Graph analysis repository
export { GraphRepository } from './graph-repository.js';
export type {
  HighConnectivitySymbol,
  NeighborhoodResult,
  UnannotatedSymbol,
  UnannotatedSymbolsResult,
} from './graph-repository.js';
