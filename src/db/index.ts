// Connection management
export { createConnection, initializeSchema, closeConnection } from './connection.js';

// Schema manager
export {
  ensureModulesTables,
  ensureFlowsTables,
  ensureDomainsTable,
  ensureRelationshipTypeColumn,
} from './schema-manager.js';

// Schema types and utilities
export * from './schema.js';

// All repositories
export * from './repositories/index.js';

// Tree utilities
export { buildTree, buildSingleRootTree } from './utils/tree-builder.js';
export type { TreeNode } from './utils/tree-builder.js';
