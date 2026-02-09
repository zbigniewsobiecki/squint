/**
 * Database Facades - Focused interfaces for specific use cases.
 *
 * These facades provide domain-specific APIs that commands can depend on
 * instead of the full IndexDatabase. This reduces coupling and makes
 * testing easier.
 *
 * Usage:
 *   import { SymbolFacade } from './facades/index.js';
 *   const symbols = new SymbolFacade(db);
 *   symbols.setDefinitionMetadata(id, 'purpose', 'Handles user auth');
 */

export { SymbolFacade, type ISymbolFacade } from './symbol-facade.js';
export { ModuleFacade, type IModuleFacade } from './module-facade.js';
export { FlowFacade, type IFlowFacade } from './flow-facade.js';
