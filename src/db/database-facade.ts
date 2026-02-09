import Database from 'better-sqlite3';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';
import {
  type AnnotatedEdgeInfo,
  type AnnotatedSymbolInfo,
  type CallGraphEdge,
  type CallsiteResult,
  type DependencyInfo,
  type DependencyWithMetadata,
  type Domain,
  type DomainWithCount,
  type EnhancedRelationshipContext,
  type EnrichedModuleCallEdge,
  type ExpandedFlow,
  type FileInsert,
  type Flow,
  type FlowCoverageStats,
  type FlowDefinitionStep,
  type FlowStakeholder,
  type FlowStep,
  type FlowWithDefinitionSteps,
  type FlowWithSteps,
  type IIndexWriter,
  type IncomingDependency,
  type Interaction,
  type InteractionSource,
  type InteractionWithPaths,
  type Module,
  type ModuleCallEdge,
  type ModuleTreeNode,
  type ModuleWithMembers,
  type RelationshipAnnotation,
  type RelationshipCoverageBreakdown,
  type RelationshipInteractionCoverage,
  type RelationshipType,
  type RelationshipWithDetails,
  SCHEMA,
} from './schema.js';

import { DefinitionRepository } from './repositories/definition-repository.js';
import { DependencyRepository } from './repositories/dependency-repository.js';
import { DomainRepository } from './repositories/domain-repository.js';
import { FileRepository } from './repositories/file-repository.js';
import { type FlowInsertOptions, FlowRepository } from './repositories/flow-repository.js';
import { GraphRepository } from './repositories/graph-repository.js';
import { type InteractionInsertOptions, InteractionRepository } from './repositories/interaction-repository.js';
import { MetadataRepository } from './repositories/metadata-repository.js';
import { ModuleRepository } from './repositories/module-repository.js';
import { RelationshipRepository } from './repositories/relationship-repository.js';

/**
 * Facade class that provides backward-compatible access to all database operations.
 * Uses the new repository pattern internally.
 */
export class IndexDatabase implements IIndexWriter {
  private conn: Database.Database;

  // Repositories
  public readonly files: FileRepository;
  public readonly definitions: DefinitionRepository;
  public readonly metadata: MetadataRepository;
  public readonly dependencies: DependencyRepository;
  public readonly relationships: RelationshipRepository;
  public readonly domains: DomainRepository;
  public readonly modules: ModuleRepository;
  public readonly interactions: InteractionRepository;
  public readonly flows: FlowRepository;
  public readonly graph: GraphRepository;

  constructor(dbPath: string) {
    this.conn = new Database(dbPath);
    this.conn.pragma('journal_mode = WAL');

    // Initialize all repositories
    this.files = new FileRepository(this.conn);
    this.definitions = new DefinitionRepository(this.conn);
    this.metadata = new MetadataRepository(this.conn);
    this.dependencies = new DependencyRepository(this.conn);
    this.relationships = new RelationshipRepository(this.conn);
    this.domains = new DomainRepository(this.conn);
    this.modules = new ModuleRepository(this.conn);
    this.interactions = new InteractionRepository(this.conn);
    this.flows = new FlowRepository(this.conn);
    this.graph = new GraphRepository(this.conn);
  }

  // ============================================================
  // Schema & Lifecycle
  // ============================================================

  initialize(): void {
    this.conn.exec(`
      DROP TABLE IF EXISTS flows;
      DROP TABLE IF EXISTS module_members;
      DROP TABLE IF EXISTS modules;
      DROP TABLE IF EXISTS domains;
      DROP TABLE IF EXISTS relationship_annotations;
      DROP TABLE IF EXISTS definition_metadata;
      DROP TABLE IF EXISTS usages;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS imports;
      DROP TABLE IF EXISTS definitions;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS metadata;
    `);
    this.conn.exec(SCHEMA);
  }

  close(): void {
    this.conn.close();
  }

  // ============================================================
  // IIndexWriter Implementation
  // ============================================================

  setMetadata(key: string, value: string): void {
    const stmt = this.conn.prepare(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)
    `);
    stmt.run(key, value);
  }

  insertFile(file: FileInsert): number {
    return this.files.insert(file);
  }

  insertDefinition(fileId: number, def: Definition): number {
    return this.files.insertDefinition(fileId, def);
  }

  insertReference(fromFileId: number, toFileId: number | null, ref: FileReference): number {
    return this.files.insertReference(fromFileId, toFileId, ref);
  }

  insertSymbol(refId: number | null, defId: number | null, sym: ImportedSymbol, fileId?: number): number {
    return this.files.insertSymbol(refId, defId, sym, fileId);
  }

  insertUsage(symbolId: number, usage: SymbolUsage): void {
    this.files.insertUsage(symbolId, usage);
  }

  getDefinitionByName(fileId: number, name: string): number | null {
    return this.definitions.getByName(fileId, name);
  }

  getDefinitionCount(): number {
    return this.definitions.getCount();
  }

  getReferenceCount(): number {
    return this.files.getReferenceCount();
  }

  getUsageCount(): number {
    return this.files.getUsageCount();
  }

  getCallsites(definitionId: number): CallsiteResult[] {
    return this.dependencies.getCallsites(definitionId);
  }

  getCallsitesForFile(fileId: number): CallsiteResult[] {
    return this.dependencies.getCallsitesForFile(fileId);
  }

  getCallsiteCount(): number {
    return this.dependencies.getCallsiteCount();
  }

  // ============================================================
  // File Operations
  // ============================================================

  getAllFiles() {
    return this.files.getAll();
  }

  getAllFilesWithStats() {
    return this.files.getAllWithStats();
  }

  getFileById(id: number) {
    return this.files.getById(id);
  }

  getFileIdByPath(path: string) {
    return this.files.getIdByPath(path);
  }

  getOrphanFiles(options?: { includeIndex?: boolean; includeTests?: boolean }) {
    return this.files.getOrphans(options);
  }

  getFileImports(fileId: number) {
    return this.files.getImports(fileId);
  }

  getFileImportedBy(fileId: number) {
    return this.files.getImportedBy(fileId);
  }

  getFileCount(): number {
    return this.files.getCount();
  }

  // ============================================================
  // Definition Operations
  // ============================================================

  getDefinitionsByName(name: string) {
    return this.definitions.getAllByName(name);
  }

  getDefinitionById(id: number) {
    return this.definitions.getById(id);
  }

  getDefinitionsForFile(fileId: number) {
    return this.definitions.getForFile(fileId);
  }

  getAllDefinitions(filters?: { kind?: string; exported?: boolean }) {
    return this.definitions.getAll(filters);
  }

  getSubclasses(className: string) {
    return this.definitions.getSubclasses(className);
  }

  getImplementations(interfaceName: string) {
    return this.definitions.getImplementations(interfaceName);
  }

  getClassHierarchy() {
    return this.definitions.getClassHierarchy();
  }

  // ============================================================
  // Metadata Operations
  // ============================================================

  setDefinitionMetadata(definitionId: number, key: string, value: string): void {
    this.metadata.set(definitionId, key, value);
  }

  removeDefinitionMetadata(definitionId: number, key: string): boolean {
    return this.metadata.remove(definitionId, key);
  }

  getDefinitionMetadata(definitionId: number): Record<string, string> {
    return this.metadata.get(definitionId);
  }

  getDefinitionMetadataValue(definitionId: number, key: string): string | null {
    return this.metadata.getValue(definitionId, key);
  }

  getDefinitionsWithMetadata(key: string): number[] {
    return this.metadata.getDefinitionsWith(key);
  }

  getDefinitionsWithoutMetadata(key: string): number[] {
    return this.metadata.getDefinitionsWithout(key);
  }

  getMetadataKeys(): string[] {
    return this.metadata.getKeys();
  }

  getAspectCoverage(filters?: { kind?: string; filePattern?: string }) {
    return this.metadata.getAspectCoverage(filters);
  }

  // ============================================================
  // Dependency Operations
  // ============================================================

  getIncomingDependencies(definitionId: number, limit?: number): IncomingDependency[] {
    return this.dependencies.getIncoming(definitionId, limit);
  }

  getIncomingDependencyCount(definitionId: number): number {
    return this.dependencies.getIncomingCount(definitionId);
  }

  getDefinitionDependencies(definitionId: number): DependencyInfo[] {
    return this.dependencies.getForDefinition(definitionId);
  }

  getDependenciesWithMetadata(definitionId: number, aspect?: string): DependencyWithMetadata[] {
    return this.dependencies.getWithMetadata(definitionId, aspect);
  }

  getUnmetDependencies(definitionId: number, aspect: string): DependencyInfo[] {
    return this.dependencies.getUnmet(definitionId, aspect);
  }

  getPrerequisiteChain(definitionId: number, aspect: string) {
    return this.dependencies.getPrerequisiteChain(definitionId, aspect, (id) => this.definitions.getById(id));
  }

  getReadySymbols(aspect: string, options?: { limit?: number; kind?: string; filePattern?: string }) {
    return this.dependencies.getReadySymbols(aspect, options);
  }

  getImportGraph() {
    return this.dependencies.getImportGraph();
  }

  // ============================================================
  // Relationship Operations
  // ============================================================

  setRelationshipAnnotation(
    fromDefinitionId: number,
    toDefinitionId: number,
    semantic: string,
    relationshipType: RelationshipType = 'uses'
  ): void {
    this.relationships.set(fromDefinitionId, toDefinitionId, semantic, relationshipType);
  }

  getRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): RelationshipAnnotation | null {
    return this.relationships.get(fromDefinitionId, toDefinitionId);
  }

  removeRelationshipAnnotation(fromDefinitionId: number, toDefinitionId: number): boolean {
    return this.relationships.remove(fromDefinitionId, toDefinitionId);
  }

  getRelationshipsFrom(fromDefinitionId: number): RelationshipWithDetails[] {
    return this.relationships.getFrom(fromDefinitionId);
  }

  getRelationshipsTo(toDefinitionId: number): RelationshipWithDetails[] {
    return this.relationships.getTo(toDefinitionId);
  }

  getAllRelationshipAnnotations(options?: { limit?: number }): RelationshipWithDetails[] {
    return this.relationships.getAll(options);
  }

  getRelationshipAnnotationCount(): number {
    return this.relationships.getCount();
  }

  getUnannotatedInheritance(limit?: number) {
    return this.relationships.getUnannotatedInheritance(limit);
  }

  getUnannotatedInheritanceCount(): number {
    return this.relationships.getUnannotatedInheritanceCount();
  }

  getUnannotatedRelationships(options?: { limit?: number; fromDefinitionId?: number }) {
    return this.relationships.getUnannotated(options);
  }

  getUnannotatedRelationshipCount(fromDefinitionId?: number): number {
    return this.relationships.getUnannotatedCount(fromDefinitionId);
  }

  getNextRelationshipToAnnotate(options?: {
    limit?: number;
    fromDefinitionId?: number;
  }): EnhancedRelationshipContext[] {
    return this.relationships.getNextToAnnotate(
      options,
      (id) => this.metadata.get(id),
      (id) => this.dependencies.getForDefinition(id)
    );
  }

  // ============================================================
  // Domain Operations
  // ============================================================

  addDomain(name: string, description?: string): number | null {
    return this.domains.add(name, description);
  }

  getDomain(name: string): Domain | null {
    return this.domains.get(name);
  }

  getDomainsFromRegistry(): Domain[] {
    return this.domains.getAll();
  }

  getDomainsWithCounts(): DomainWithCount[] {
    return this.domains.getAllWithCounts();
  }

  updateDomainDescription(name: string, description: string): boolean {
    return this.domains.updateDescription(name, description);
  }

  renameDomain(oldName: string, newName: string) {
    return this.domains.rename(oldName, newName);
  }

  mergeDomains(fromName: string, intoName: string) {
    return this.domains.merge(fromName, intoName);
  }

  removeDomain(name: string, force = false) {
    return this.domains.remove(name, force);
  }

  syncDomainsFromMetadata(): string[] {
    return this.domains.syncFromMetadata();
  }

  getUnregisteredDomains(): string[] {
    return this.domains.getUnregistered();
  }

  isDomainRegistered(name: string): boolean {
    return this.domains.isRegistered(name);
  }

  getAllDomains(): string[] {
    return this.metadata.getAllDomains();
  }

  getSymbolsByDomain(domain: string) {
    return this.domains.getSymbolsByDomain(domain);
  }

  getSymbolsByPurity(isPure: boolean) {
    return this.domains.getSymbolsByPurity(isPure);
  }

  // ============================================================
  // Module Operations
  // ============================================================

  ensureRootModule(): number {
    return this.modules.ensureRoot();
  }

  insertModule(parentId: number | null, slug: string, name: string, description?: string, isTest?: boolean): number {
    return this.modules.insert(parentId, slug, name, description, isTest);
  }

  getModuleByPath(fullPath: string): Module | null {
    return this.modules.getByPath(fullPath);
  }

  getModuleById(id: number): Module | null {
    return this.modules.getById(id);
  }

  getModuleChildren(moduleId: number): Module[] {
    return this.modules.getChildren(moduleId);
  }

  getAllModules(): Module[] {
    return this.modules.getAll();
  }

  getModuleTree(): ModuleTreeNode | null {
    return this.modules.getTree();
  }

  assignSymbolToModule(definitionId: number, moduleId: number): void {
    this.modules.assignSymbol(definitionId, moduleId);
  }

  getUnassignedSymbols(): AnnotatedSymbolInfo[] {
    return this.modules.getUnassigned();
  }

  getModuleSymbols(moduleId: number) {
    return this.modules.getSymbols(moduleId);
  }

  getModuleWithMembers(moduleId: number): ModuleWithMembers | null {
    return this.modules.getWithMembers(moduleId);
  }

  getAllModulesWithMembers(): ModuleWithMembers[] {
    return this.modules.getAllWithMembers();
  }

  clearModules(): void {
    this.modules.clear();
  }

  getModuleStats() {
    return this.modules.getStats();
  }

  getModuleCount(): number {
    return this.modules.getCount();
  }

  getDefinitionModule(definitionId: number) {
    return this.modules.getDefinitionModule(definitionId);
  }

  getCallGraph(): CallGraphEdge[] {
    return this.modules.getCallGraph();
  }

  getIncomingEdgesFor(definitionId: number) {
    return this.modules.getIncomingEdgesFor(definitionId);
  }

  getModulesExceedingThreshold(threshold: number): ModuleWithMembers[] {
    return this.modules.getModulesExceedingThreshold(threshold);
  }

  getTestModuleIds(): Set<number> {
    return this.modules.getTestModuleIds();
  }

  assignColorIndices(): void {
    this.modules.assignColorIndices();
  }

  // ============================================================
  // Interaction Operations
  // ============================================================

  insertInteraction(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number {
    return this.interactions.insert(fromModuleId, toModuleId, options);
  }

  upsertInteraction(fromModuleId: number, toModuleId: number, options?: InteractionInsertOptions): number {
    return this.interactions.upsert(fromModuleId, toModuleId, options);
  }

  getInteractionById(id: number): Interaction | null {
    return this.interactions.getById(id);
  }

  getInteractionByModules(fromModuleId: number, toModuleId: number): Interaction | null {
    return this.interactions.getByModules(fromModuleId, toModuleId);
  }

  getAllInteractions(): InteractionWithPaths[] {
    return this.interactions.getAll();
  }

  getInteractionsByPattern(pattern: 'utility' | 'business'): InteractionWithPaths[] {
    return this.interactions.getByPattern(pattern);
  }

  getInteractionsFromModule(moduleId: number): InteractionWithPaths[] {
    return this.interactions.getFromModule(moduleId);
  }

  getInteractionsToModule(moduleId: number): InteractionWithPaths[] {
    return this.interactions.getToModule(moduleId);
  }

  updateInteraction(
    id: number,
    updates: {
      direction?: 'uni' | 'bi';
      pattern?: 'utility' | 'business' | 'test-internal';
      symbols?: string[];
      semantic?: string;
    }
  ): boolean {
    return this.interactions.update(id, updates);
  }

  deleteInteraction(id: number): boolean {
    return this.interactions.delete(id);
  }

  clearInteractions(): number {
    return this.interactions.clear();
  }

  getInteractionCount(): number {
    return this.interactions.getCount();
  }

  getInteractionStats() {
    return this.interactions.getStats();
  }

  getModuleCallGraph(): ModuleCallEdge[] {
    return this.interactions.getModuleCallGraph();
  }

  getEnrichedModuleCallGraph(): EnrichedModuleCallEdge[] {
    return this.interactions.getEnrichedModuleCallGraph();
  }

  syncInteractionsFromCallGraph(): { created: number; updated: number } {
    return this.interactions.syncFromCallGraph();
  }

  getRelationshipCoverage(): RelationshipInteractionCoverage {
    return this.interactions.getRelationshipCoverage();
  }

  getRelationshipCoverageBreakdown(): RelationshipCoverageBreakdown {
    return this.interactions.getRelationshipCoverageBreakdown();
  }

  syncInheritanceInteractions(): { created: number } {
    return this.interactions.syncInheritanceInteractions();
  }

  getInteractionsBySource(source: InteractionSource): InteractionWithPaths[] {
    return this.interactions.getBySource(source);
  }

  getInferredInteractionCount(): number {
    return this.interactions.getCountBySource('llm-inferred');
  }

  getUncoveredModulePairs() {
    return this.interactions.getUncoveredModulePairs();
  }

  // ============================================================
  // Flow Operations
  // ============================================================

  insertFlow(name: string, slug: string, options?: FlowInsertOptions): number {
    return this.flows.insert(name, slug, options);
  }

  getFlowById(flowId: number): Flow | null {
    return this.flows.getById(flowId);
  }

  getFlowBySlug(slug: string): Flow | null {
    return this.flows.getBySlug(slug);
  }

  getAllFlows(): Flow[] {
    return this.flows.getAll();
  }

  getFlowsByStakeholder(stakeholder: FlowStakeholder): Flow[] {
    return this.flows.getByStakeholder(stakeholder);
  }

  getFlowsByEntryPoint(entryPointId: number): Flow[] {
    return this.flows.getByEntryPoint(entryPointId);
  }

  getFlowsByEntryPointModule(entryPointModuleId: number): Flow[] {
    return this.flows.getByEntryPointModule(entryPointModuleId);
  }

  getFlowWithSteps(flowId: number): FlowWithSteps | null {
    return this.flows.getWithSteps(flowId);
  }

  updateFlow(
    flowId: number,
    updates: {
      name?: string;
      entryPointModuleId?: number;
      entryPointId?: number;
      entryPath?: string;
      stakeholder?: FlowStakeholder;
      description?: string;
      actionType?: string;
      targetEntity?: string;
    }
  ): boolean {
    return this.flows.update(flowId, updates);
  }

  deleteFlow(flowId: number): boolean {
    return this.flows.delete(flowId);
  }

  clearFlows(): number {
    return this.flows.clear();
  }

  getFlowCount(): number {
    return this.flows.getCount();
  }

  getFlowStats() {
    return this.flows.getStats();
  }

  // Flow Steps Operations

  addFlowStep(flowId: number, interactionId: number, stepOrder?: number): void {
    this.flows.addStep(flowId, interactionId, stepOrder);
  }

  addFlowSteps(flowId: number, interactionIds: number[]): void {
    this.flows.addSteps(flowId, interactionIds);
  }

  removeFlowStep(flowId: number, stepOrder: number): boolean {
    return this.flows.removeStep(flowId, stepOrder);
  }

  clearFlowSteps(flowId: number): number {
    return this.flows.clearSteps(flowId);
  }

  getFlowSteps(flowId: number): FlowStep[] {
    return this.flows.getSteps(flowId);
  }

  reorderFlowSteps(flowId: number, interactionIds: number[]): void {
    this.flows.reorderSteps(flowId, interactionIds);
  }

  expandFlow(flowId: number): ExpandedFlow | null {
    return this.flows.expand(flowId);
  }

  getFlowCoverage(): FlowCoverageStats {
    return this.flows.getCoverage();
  }

  getFlowsWithInteraction(interactionId: number): Flow[] {
    return this.flows.getFlowsWithInteraction(interactionId);
  }

  getUncoveredInteractions(): InteractionWithPaths[] {
    return this.flows.getUncoveredInteractions();
  }

  // Flow Definition Steps Operations

  addFlowDefinitionStep(flowId: number, fromDefinitionId: number, toDefinitionId: number, stepOrder?: number): void {
    this.flows.addDefinitionStep(flowId, fromDefinitionId, toDefinitionId, stepOrder);
  }

  addFlowDefinitionSteps(flowId: number, steps: Array<{ fromDefinitionId: number; toDefinitionId: number }>): void {
    this.flows.addDefinitionSteps(flowId, steps);
  }

  clearFlowDefinitionSteps(flowId: number): number {
    return this.flows.clearDefinitionSteps(flowId);
  }

  getFlowDefinitionSteps(flowId: number): FlowDefinitionStep[] {
    return this.flows.getDefinitionSteps(flowId);
  }

  getFlowWithDefinitionSteps(flowId: number): FlowWithDefinitionSteps | null {
    return this.flows.getWithDefinitionSteps(flowId);
  }

  getFlowDefinitionStepCount(flowId: number): number {
    return this.flows.getDefinitionStepCount(flowId);
  }

  // Definition-Level Call Graph

  getDefinitionCallGraph(): CallGraphEdge[] {
    return this.interactions.getDefinitionCallGraph();
  }

  getDefinitionCallGraphMap(): Map<number, number[]> {
    return this.interactions.getDefinitionCallGraphMap();
  }

  // ============================================================
  // Graph Operations
  // ============================================================

  findCycles(aspect: string): number[][] {
    return this.graph.findCycles(aspect);
  }

  getCallGraphNeighborhood(
    startId: number,
    maxDepth: number,
    maxNodes: number
  ): { nodes: AnnotatedSymbolInfo[]; edges: AnnotatedEdgeInfo[] } {
    return this.graph.getNeighborhood(startId, maxDepth, maxNodes);
  }

  getHighConnectivitySymbols(options?: {
    minIncoming?: number;
    minOutgoing?: number;
    exported?: boolean;
    limit?: number;
  }) {
    return this.graph.getHighConnectivitySymbols(options);
  }

  edgeExists(fromId: number, toId: number): boolean {
    return this.graph.edgeExists(fromId, toId);
  }

  createInheritanceRelationships(): { extendsCreated: number; implementsCreated: number; notFound: number } {
    const result = this.graph.createInheritanceRelationships();
    return { extendsCreated: result.created, implementsCreated: 0, notFound: 0 };
  }

  getNextToAnnotate(aspect: string, options?: { limit?: number; kind?: string; filePattern?: string }) {
    return this.graph.getNextToAnnotate(aspect, options);
  }

  getAllUnannotatedSymbols(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string; excludePattern?: string }
  ) {
    return this.graph.getAllUnannotated(aspect, options);
  }

  // ============================================================
  // Aliases and Additional Methods
  // ============================================================

  /**
   * Get overall database stats
   */
  getStats() {
    const files = this.files.getCount();
    const definitions = this.definitions.getCount();
    const imports = this.files.getReferenceCount();
    const usages = this.files.getUsageCount();
    const callsites = this.dependencies.getCallsiteCount();
    const moduleStats = this.modules.getStats();
    const flowStats = this.flows.getStats();
    const relationships = this.relationships.getCount();

    const interactionCount = this.interactions.getCount();

    return {
      files,
      definitions,
      imports,
      usages,
      callsites,
      modules: moduleStats.moduleCount,
      assignedSymbols: moduleStats.assigned,
      unassignedSymbols: moduleStats.unassigned,
      flows: flowStats.flowCount,
      interactions: interactionCount,
      relationships,
    };
  }

  /**
   * Alias for getFileIdByPath
   */
  getFileId(path: string): number | null {
    return this.files.getIdByPath(path);
  }

  /**
   * Alias for getFileImportedBy
   */
  getFilesImportedBy(fileId: number) {
    return this.files.getImportedBy(fileId);
  }

  /**
   * Alias for getReadySymbols
   */
  getReadyToUnderstandSymbols(aspect: string, options?: { limit?: number; kind?: string; filePattern?: string }) {
    const result = this.dependencies.getReadySymbols(aspect, options);
    return {
      symbols: result.symbols,
      totalReady: result.totalReady,
      remaining: result.remaining,
    };
  }

  /**
   * Get filtered definition count
   */
  getFilteredDefinitionCount(filters?: { kind?: string; filePattern?: string }): number {
    return this.metadata.getFilteredCount(filters);
  }

  /**
   * Get symbols (definitions) with optional filters
   */
  getSymbols(filters?: { kind?: string; fileId?: number }) {
    return this.definitions.getSymbols(filters);
  }

  /**
   * Alias for getDefinitionsForFile
   */
  getFileDefinitions(fileId: number) {
    return this.definitions.getForFile(fileId);
  }

  /**
   * Get exported definitions that are not called by anything (entry points)
   */
  getRootDefinitions(): Array<{ id: number; name: string; kind: string; filePath: string; line: number }> {
    // Get all call graph edges to find definitions that are called
    const callGraph = this.modules.getCallGraph();
    const calledIds = new Set<number>();
    for (const edge of callGraph) {
      calledIds.add(edge.toId);
    }

    // Get all exported definitions
    const allDefs = this.conn
      .prepare(`
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.is_exported = 1
      ORDER BY f.path, d.line
    `)
      .all() as Array<{ id: number; name: string; kind: string; filePath: string; line: number }>;

    // Filter to only those not called
    return allDefs.filter((def) => !calledIds.has(def.id));
  }
}
