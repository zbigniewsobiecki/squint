import Database from 'better-sqlite3';
import type { Definition } from '../parser/definition-extractor.js';
import type { FileReference, ImportedSymbol, SymbolUsage } from '../parser/reference-extractor.js';
import {
  FileInsert,
  CallsiteResult,
  DependencyInfo,
  DependencyWithMetadata,
  IncomingDependency,
  RelationshipType,
  RelationshipAnnotation,
  RelationshipWithDetails,
  Domain,
  DomainWithCount,
  Module,
  ModuleTreeNode,
  ModuleWithMembers,
  CallGraphEdge,
  Flow,
  FlowTreeNode,
  ModuleCallEdge,
  FlowCoverageStats,
  AnnotatedSymbolInfo,
  AnnotatedEdgeInfo,
  EnhancedRelationshipContext,
  IIndexWriter,
  SCHEMA,
} from './schema.js';

import { FileRepository } from './repositories/file-repository.js';
import { DefinitionRepository } from './repositories/definition-repository.js';
import { MetadataRepository } from './repositories/metadata-repository.js';
import { DependencyRepository } from './repositories/dependency-repository.js';
import { RelationshipRepository } from './repositories/relationship-repository.js';
import { DomainRepository } from './repositories/domain-repository.js';
import { ModuleRepository } from './repositories/module-repository.js';
import { FlowRepository, FlowInsertOptions } from './repositories/flow-repository.js';
import { GraphRepository } from './repositories/graph-repository.js';

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
    return this.dependencies.getPrerequisiteChain(
      definitionId,
      aspect,
      (id) => this.definitions.getById(id)
    );
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

  getNextRelationshipToAnnotate(options?: { limit?: number; fromDefinitionId?: number }): EnhancedRelationshipContext[] {
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

  insertModule(parentId: number | null, slug: string, name: string, description?: string): number {
    return this.modules.insert(parentId, slug, name, description);
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

  // ============================================================
  // Flow Operations
  // ============================================================

  ensureRootFlow(slug: string): Flow {
    return this.flows.ensureRoot(slug);
  }

  insertFlow(parentId: number | null, slug: string, name: string, options?: FlowInsertOptions): number {
    return this.flows.insert(parentId, slug, name, options);
  }

  getFlowByPath(fullPath: string): Flow | null {
    return this.flows.getByPath(fullPath);
  }

  getFlowById(flowId: number): Flow | null {
    return this.flows.getById(flowId);
  }

  getFlowBySlug(slug: string): Flow | null {
    return this.flows.getBySlug(slug);
  }

  getFlowChildren(flowId: number): Flow[] {
    return this.flows.getChildren(flowId);
  }

  getAllFlows(): Flow[] {
    return this.flows.getAll();
  }

  getFlows(): Flow[] {
    return this.flows.getAll();
  }

  getFlowTree(): FlowTreeNode[] {
    return this.flows.getTree();
  }

  getLeafFlows(): Flow[] {
    return this.flows.getLeaves();
  }

  getFlowsForModuleTransition(fromModuleId: number, toModuleId: number): Flow[] {
    return this.flows.getForModuleTransition(fromModuleId, toModuleId);
  }

  expandFlow(flowId: number): Flow[] {
    return this.flows.expand(flowId);
  }

  updateFlow(flowId: number, updates: { name?: string; description?: string; semantic?: string; domain?: string }): boolean {
    return this.flows.update(flowId, updates);
  }

  reparentFlow(flowId: number, newParentId: number | null, stepOrder?: number): void {
    this.flows.reparent(flowId, newParentId, stepOrder);
  }

  reparentFlows(flowIds: number[], newParentId: number): void {
    this.flows.reparentMany(flowIds, newParentId);
  }

  deleteFlow(flowId: number): number {
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

  getModuleCallGraph(): ModuleCallEdge[] {
    return this.flows.getModuleCallGraph();
  }

  getFlowCoverage(): FlowCoverageStats {
    return this.flows.getCoverage();
  }

  getOrphanFlows(depth: number): Flow[] {
    return this.flows.getOrphans(depth);
  }

  // ============================================================
  // Graph Operations
  // ============================================================

  findCycles(aspect: string): number[][] {
    return this.graph.findCycles(aspect);
  }

  getCallGraphNeighborhood(startId: number, maxDepth: number, maxNodes: number): { nodes: AnnotatedSymbolInfo[]; edges: AnnotatedEdgeInfo[] } {
    return this.graph.getNeighborhood(startId, maxDepth, maxNodes);
  }

  getHighConnectivitySymbols(options?: { minIncoming?: number; minOutgoing?: number; exported?: boolean; limit?: number }) {
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

  getAllUnannotatedSymbols(aspect: string, options?: { limit?: number; kind?: string; filePattern?: string; excludePattern?: string }) {
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
      leafFlows: flowStats.leafFlowCount,
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
    const allDefs = this.conn.prepare(`
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
    `).all() as Array<{ id: number; name: string; kind: string; filePath: string; line: number }>;

    // Filter to only those not called
    return allDefs.filter(def => !calledIds.has(def.id));
  }
}
