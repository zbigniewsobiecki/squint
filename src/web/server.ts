import * as http from 'node:http';
import type { IndexDatabase } from '../db/database.js';

/**
 * Create the HTTP server for the browse command
 */
export function createServer(db: IndexDatabase, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const path = url.pathname;

    // CORS headers for API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Route handling
      if (path === '/') {
        serveHTML(res);
      } else if (path === '/api/stats') {
        jsonResponse(res, db.getStats());
      } else if (path === '/api/files') {
        jsonResponse(res, db.getAllFiles());
      } else if (path.match(/^\/api\/files\/(\d+)$/)) {
        const id = parseInt(path.split('/')[3]);
        const file = db.getFileById(id);
        if (file) {
          const definitions = db.getFileDefinitions(id);
          const imports = db.getFileImports(id);
          jsonResponse(res, { ...file, definitions, imports });
        } else {
          notFound(res, 'File not found');
        }
      } else if (path === '/api/definitions') {
        const kind = url.searchParams.get('kind') || undefined;
        const exportedParam = url.searchParams.get('exported');
        const exported = exportedParam === null ? undefined : exportedParam === 'true';
        jsonResponse(res, db.getAllDefinitions({ kind, exported }));
      } else if (path.match(/^\/api\/definitions\/(\d+)$/)) {
        const id = parseInt(path.split('/')[3]);
        const def = db.getDefinitionById(id);
        if (def) {
          jsonResponse(res, def);
        } else {
          notFound(res, 'Definition not found');
        }
      } else if (path.match(/^\/api\/definitions\/(\d+)\/callsites$/)) {
        const id = parseInt(path.split('/')[3]);
        const callsites = db.getCallsites(id);
        jsonResponse(res, callsites);
      } else if (path === '/api/graph/imports') {
        jsonResponse(res, db.getImportGraph());
      } else if (path === '/api/graph/classes') {
        jsonResponse(res, db.getClassHierarchy());
      } else if (path === '/api/graph/symbols') {
        jsonResponse(res, getSymbolGraph(db));
      } else if (path === '/api/modules') {
        jsonResponse(res, getModulesData(db));
      } else if (path === '/api/modules/stats') {
        jsonResponse(res, db.getModuleStats());
      } else if (path.match(/^\/api\/modules\/(\d+)$/)) {
        const id = parseInt(path.split('/')[3]);
        const module = db.getModuleWithMembers(id);
        if (module) {
          jsonResponse(res, module);
        } else {
          notFound(res, 'Module not found');
        }
      } else if (path === '/api/flows') {
        jsonResponse(res, getFlowsData(db));
      } else if (path === '/api/flows/stats') {
        jsonResponse(res, db.getFlowStats());
      } else if (path.match(/^\/api\/flows\/(\d+)$/)) {
        const id = parseInt(path.split('/')[3]);
        const flow = db.getFlowWithSteps(id);
        if (flow) {
          jsonResponse(res, flow);
        } else {
          notFound(res, 'Flow not found');
        }
      } else if (path.match(/^\/api\/flows\/(\d+)\/dag$/)) {
        const id = parseInt(path.split('/')[3]);
        const dag = db.getFlowDAG(id);
        if (dag) {
          jsonResponse(res, dag);
        } else {
          notFound(res, 'Flow not found');
        }
      } else {
        notFound(res, 'Not found');
      }
    } catch (error) {
      console.error('Error handling request:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return server;
}

/**
 * Start the HTTP server
 */
export function startServer(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      resolve();
    });
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: http.ServerResponse, message: string): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function serveHTML(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(getEmbeddedHTML());
}

/**
 * Build the symbol graph data for D3 visualization
 */
function getSymbolGraph(db: IndexDatabase): {
  nodes: Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    hasAnnotations: boolean;
    purpose?: string;
    domain?: string[];
    pure?: boolean;
    lines: number;
    moduleId?: number;
    moduleName?: string;
  }>;
  edges: Array<{
    source: number;
    target: number;
    semantic: string;
  }>;
  stats: {
    totalSymbols: number;
    annotatedSymbols: number;
    totalRelationships: number;
    moduleCount: number;
  };
} {
  // Get all definitions as nodes
  const allDefs = db.getAllDefinitions();

  // Get all relationship annotations (edges with labels)
  // Handle case where table doesn't exist in older databases
  let relationships: ReturnType<typeof db.getAllRelationshipAnnotations> = [];
  try {
    relationships = db.getAllRelationshipAnnotations({ limit: 10000 });
  } catch {
    // Table doesn't exist - continue with empty relationships
  }

  // Track which definition IDs have annotations
  const annotatedIds = new Set<number>();
  for (const rel of relationships) {
    annotatedIds.add(rel.fromDefinitionId);
    annotatedIds.add(rel.toDefinitionId);
  }

  // Get file paths for each definition
  const fileMap = new Map<number, string>();
  const files = db.getAllFiles();
  for (const file of files) {
    fileMap.set(file.id, file.path);
  }

  // Get metadata for all definitions
  const metadataMap = new Map<number, Record<string, string>>();
  for (const def of allDefs) {
    const metadata = db.getDefinitionMetadata(def.id);
    if (Object.keys(metadata).length > 0) {
      metadataMap.set(def.id, metadata);
    }
  }

  // Get module membership for all definitions
  const moduleMap = new Map<number, { moduleId: number; moduleName: string }>();
  let moduleCount = 0;
  try {
    const modules = db.getAllModulesWithMembers();
    moduleCount = modules.length;
    for (const module of modules) {
      for (const member of module.members) {
        moduleMap.set(member.definitionId, { moduleId: module.id, moduleName: module.name });
      }
    }
  } catch {
    // Module tables don't exist - continue without module info
  }

  // Build nodes array with metadata
  const nodes = allDefs.map(def => {
    const metadata = metadataMap.get(def.id) || {};
    let domain: string[] | undefined;
    if (metadata.domain) {
      try {
        domain = JSON.parse(metadata.domain);
      } catch {
        domain = [metadata.domain];
      }
    }
    const moduleInfo = moduleMap.get(def.id);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      filePath: fileMap.get(def.fileId) || '',
      hasAnnotations: annotatedIds.has(def.id),
      purpose: metadata.purpose,
      domain,
      pure: metadata.pure ? metadata.pure === 'true' : undefined,
      lines: def.endLine - def.line + 1,
      moduleId: moduleInfo?.moduleId,
      moduleName: moduleInfo?.moduleName,
    };
  });

  // Build edges array from relationships
  const edges = relationships.map(rel => ({
    source: rel.fromDefinitionId,
    target: rel.toDefinitionId,
    semantic: rel.semantic,
  }));

  return {
    nodes,
    edges,
    stats: {
      totalSymbols: nodes.length,
      annotatedSymbols: annotatedIds.size,
      totalRelationships: relationships.length,
      moduleCount,
    },
  };
}

/**
 * Build the modules data for visualization
 */
function getModulesData(database: IndexDatabase): {
  modules: Array<{
    id: number;
    parentId: number | null;
    slug: string;
    name: string;
    fullPath: string;
    description: string | null;
    depth: number;
    memberCount: number;
    members: Array<{
      definitionId: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
    }>;
  }>;
  stats: {
    moduleCount: number;
    assigned: number;
    unassigned: number;
  };
} {
  try {
    const modulesWithMembers = database.getAllModulesWithMembers();
    const stats = database.getModuleStats();

    return {
      modules: modulesWithMembers.map(module => ({
        id: module.id,
        parentId: module.parentId,
        slug: module.slug,
        name: module.name,
        fullPath: module.fullPath,
        description: module.description,
        depth: module.depth,
        memberCount: module.members.length,
        members: module.members,
      })),
      stats,
    };
  } catch {
    // Tables don't exist - return empty
    return {
      modules: [],
      stats: {
        moduleCount: 0,
        assigned: 0,
        unassigned: 0,
      },
    };
  }
}

/**
 * Build the flows data for API response
 */
function getFlowsData(database: IndexDatabase): {
  flows: Array<{
    id: number;
    name: string;
    description: string | null;
    domain: string | null;
    entryPoint: {
      id: number;
      name: string;
      kind: string;
      filePath: string;
    };
    stepCount: number;
    modulesCrossed: string[];
    steps: Array<{
      stepOrder: number;
      name: string;
      kind: string;
      filePath: string;
      moduleName: string | null;
      layer: string | null;
    }>;
  }>;
  stats: {
    flowCount: number;
    totalSteps: number;
    avgStepsPerFlow: number;
    modulesCovered: number;
  };
} {
  try {
    const flowsWithSteps = database.getAllFlowsWithSteps();
    const stats = database.getFlowStats();

    return {
      flows: flowsWithSteps.map(flow => {
        // Collect unique module names
        const moduleNames = new Set<string>();
        for (const step of flow.steps) {
          if (step.moduleName) {
            moduleNames.add(step.moduleName);
          }
        }

        return {
          id: flow.id,
          name: flow.name,
          description: flow.description,
          domain: flow.domain,
          entryPoint: {
            id: flow.entryPointId,
            name: flow.entryPointName,
            kind: flow.entryPointKind,
            filePath: flow.entryPointFilePath,
          },
          stepCount: flow.steps.length,
          modulesCrossed: Array.from(moduleNames),
          steps: flow.steps.map(step => ({
            stepOrder: step.stepOrder,
            name: step.name,
            kind: step.kind,
            filePath: step.filePath,
            moduleName: step.moduleName,
            layer: step.layer,
          })),
        };
      }),
      stats,
    };
  } catch {
    // Tables don't exist - return empty
    return {
      flows: [],
      stats: {
        flowCount: 0,
        totalSteps: 0,
        avgStepsPerFlow: 0,
        modulesCovered: 0,
      },
    };
  }
}

function getEmbeddedHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATS Symbol Graph</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #1e1e1e;
      color: #d4d4d4;
      height: 100vh;
      overflow: hidden;
    }

    .container {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    /* Header */
    header {
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }

    header h1 {
      font-size: 18px;
      font-weight: 600;
      color: #e0e0e0;
    }

    .stats {
      display: flex;
      gap: 16px;
      margin-left: auto;
      font-size: 13px;
      color: #858585;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .stat-value {
      color: #4fc1ff;
      font-weight: 500;
    }

    .stat-value.annotated {
      color: #6a9955;
    }

    /* Graph Container */
    .graph-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .graph-container svg {
      width: 100%;
      height: 100%;
    }

    /* Graph Styles */
    .node circle {
      cursor: pointer;
      transition: stroke-width 0.2s;
    }

    .node circle:hover {
      stroke-width: 3px;
    }

    .node text {
      font-size: 10px;
      fill: #d4d4d4;
      pointer-events: none;
    }

    .node.greyed-out circle {
      opacity: 0.3;
    }

    .node.greyed-out text {
      opacity: 0.4;
    }

    .link {
      stroke-opacity: 0.6;
      fill: none;
    }

    .link-label {
      font-size: 9px;
      fill: #858585;
      pointer-events: none;
    }

    /* Arrow marker */
    marker path {
      fill: #4a4a4a;
    }

    /* Tooltip */
    .tooltip {
      position: absolute;
      background: #3c3c3c;
      border: 1px solid #4a4a4a;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      max-width: 450px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .tooltip .name {
      font-weight: 600;
      color: #e0e0e0;
      margin-bottom: 4px;
    }

    .tooltip .kind {
      display: inline-block;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 500;
      margin-right: 6px;
    }

    .tooltip .lines {
      font-size: 10px;
      color: #858585;
    }

    .tooltip .location {
      color: #858585;
      font-size: 11px;
    }

    .tooltip .semantic {
      color: #ce9178;
      font-size: 11px;
      margin-top: 4px;
      font-style: italic;
    }

    .tooltip .domains {
      margin: 6px 0;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .tooltip .domain-tag {
      background: #2d4a5a;
      color: #8cc4d4;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
    }

    .tooltip .pure {
      font-size: 10px;
      margin: 4px 0;
      padding: 2px 6px;
      border-radius: 3px;
      display: inline-block;
    }

    .tooltip .pure.is-pure {
      background: #2d5a3d;
      color: #8cd4a8;
    }

    .tooltip .pure.has-side-effects {
      background: #5a3d2d;
      color: #d4a88c;
    }

    .tooltip .purpose {
      color: #d4d4d4;
      font-size: 11px;
      margin-top: 6px;
      line-height: 1.4;
      border-top: 1px solid #4a4a4a;
      padding-top: 6px;
    }

    /* Kind colors */
    .kind-function { background: #3d5a80; color: #a8d0e6; }
    .kind-class { background: #5a3d80; color: #d0a8e6; }
    .kind-interface { background: #3d8050; color: #a8e6b4; }
    .kind-type { background: #806a3d; color: #e6d4a8; }
    .kind-variable, .kind-const { background: #803d3d; color: #e6a8a8; }
    .kind-enum { background: #3d6880; color: #a8cce6; }
    .kind-method { background: #4a6670; color: #b8d4dc; }

    /* Legend */
    .legend {
      position: absolute;
      bottom: 16px;
      left: 16px;
      background: rgba(37, 37, 38, 0.9);
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 12px;
      font-size: 11px;
    }

    .legend-title {
      color: #858585;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .legend-circle {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid #3c3c3c;
    }

    .legend-circle.greyed {
      opacity: 0.3;
    }

    /* View Toggle */
    .view-toggle {
      display: flex;
      gap: 4px;
      background: #1e1e1e;
      border-radius: 4px;
      padding: 2px;
    }

    .view-btn {
      background: transparent;
      border: none;
      color: #858585;
      padding: 6px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s, color 0.2s;
    }

    .view-btn:hover {
      color: #d4d4d4;
    }

    .view-btn.active {
      background: #3c3c3c;
      color: #d4d4d4;
    }

    /* Tree Styles */
    .tree-link {
      fill: none;
      stroke: #4a4a4a;
      stroke-width: 1.5;
    }

    .tree-node {
      cursor: pointer;
    }

    .tree-node circle {
      transition: stroke-width 0.2s;
    }

    .tree-node:hover circle {
      stroke-width: 3px;
    }

    .tree-node text {
      font-size: 10px;
      fill: #d4d4d4;
      pointer-events: none;
    }

    .tree-node.collapsed circle {
      stroke-dasharray: 3,2;
    }

    /* Relationship Filters */
    .relationship-filters {
      display: none;  /* Hidden by default, shown in hierarchy view */
      gap: 6px;
      align-items: center;
    }

    .relationship-filters.visible {
      display: flex;
    }

    .filter-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid;
      transition: opacity 0.2s;
    }

    .filter-chip.active {
      opacity: 1;
    }

    .filter-chip.inactive {
      opacity: 0.4;
    }

    .filter-chip .chip-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    /* Modules & Flows List Views */
    .list-view {
      padding: 20px;
      overflow-y: auto;
      height: 100%;
    }

    .list-view h2 {
      color: #e0e0e0;
      font-size: 16px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .list-view .view-stats {
      font-size: 12px;
      color: #858585;
      font-weight: normal;
    }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 16px;
    }

    .card {
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 6px;
      padding: 16px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
    }

    .card:hover {
      border-color: #4fc1ff;
      background: #2d2d2d;
    }

    .card.expanded {
      grid-column: 1 / -1;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: #e0e0e0;
    }

    .card-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }

    .card-badge.layer-controller { background: #3d5a80; color: #a8d0e6; }
    .card-badge.layer-service { background: #5a3d80; color: #d0a8e6; }
    .card-badge.layer-repository { background: #3d8050; color: #a8e6b4; }
    .card-badge.layer-adapter { background: #806a3d; color: #e6d4a8; }
    .card-badge.layer-utility { background: #4a6670; color: #b8d4dc; }

    .card-description {
      font-size: 12px;
      color: #858585;
      margin-bottom: 10px;
      line-height: 1.4;
    }

    .card-meta {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: #666;
    }

    .card-meta-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .card-meta-value {
      color: #4fc1ff;
    }

    /* Members/Steps list inside expanded card */
    .card-members {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #3c3c3c;
      display: none;
    }

    .card.expanded .card-members {
      display: block;
    }

    .card-members h4 {
      font-size: 11px;
      color: #858585;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .member-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 300px;
      overflow-y: auto;
    }

    .member-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: #1e1e1e;
      border-radius: 4px;
      font-size: 12px;
    }

    .member-kind {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 3px;
      font-weight: 500;
      min-width: 50px;
      text-align: center;
    }

    .member-name {
      color: #d4d4d4;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
    }

    .member-file {
      color: #666;
      margin-left: auto;
      font-size: 10px;
    }

    /* Flow step indicators */
    .step-number {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #3c3c3c;
      color: #858585;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .step-arrow {
      color: #4a4a4a;
      margin: 0 4px;
    }

    /* Modules crossed badges */
    .modules-crossed {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }

    .module-tag {
      font-size: 10px;
      padding: 2px 6px;
      background: #2d4a5a;
      color: #8cc4d4;
      border-radius: 3px;
    }

    /* Flow DAG Styles */
    .card-dag-container {
      margin-top: 16px;
      border-top: 1px solid #3c3c3c;
      padding-top: 12px;
      display: none;
    }

    .card.expanded .card-dag-container {
      display: block;
    }

    .card-dag-container h4 {
      font-size: 11px;
      color: #858585;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .card-dag-svg-container {
      position: relative;
      width: 100%;
      height: 280px;
      background: #1e1e1e;
      border-radius: 6px;
      overflow: hidden;
    }

    .card-dag-svg-container svg {
      width: 100%;
      height: 100%;
    }

    .card-dag-loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #858585;
      font-size: 12px;
    }

    .dag-link {
      fill: none;
      stroke: #4a4a4a;
      stroke-width: 2;
      stroke-opacity: 0.8;
    }

    .dag-link:hover {
      stroke: #6a6a6a;
      stroke-width: 3;
    }

    .dag-node {
      cursor: pointer;
    }

    .dag-node rect {
      rx: 4;
      ry: 4;
      stroke-width: 2;
      transition: stroke-width 0.2s;
    }

    .dag-node:hover rect {
      stroke-width: 3;
    }

    .dag-node text {
      font-size: 11px;
      fill: #d4d4d4;
      pointer-events: none;
    }

    .dag-node.entry-point rect {
      stroke: #4fc1ff;
      stroke-width: 3;
    }

    .dag-node.entry-point text.entry-badge {
      fill: #4fc1ff;
      font-size: 9px;
      font-weight: 600;
    }

    /* Layer colors for DAG nodes */
    .dag-node.layer-controller rect { fill: #3d5a80; stroke: #5a7a9a; }
    .dag-node.layer-service rect { fill: #5a3d80; stroke: #7a5a9a; }
    .dag-node.layer-repository rect { fill: #3d8050; stroke: #5a9a6a; }
    .dag-node.layer-adapter rect { fill: #806a3d; stroke: #9a8a5a; }
    .dag-node.layer-utility rect { fill: #4a6670; stroke: #6a8690; }
    .dag-node.layer-default rect { fill: #4a4a4a; stroke: #6a6a6a; }

    /* Loading */
    .loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #858585;
      font-size: 14px;
    }

    /* Empty state */
    .empty-state {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: #858585;
    }

    .empty-state h2 {
      color: #d4d4d4;
      margin-bottom: 8px;
    }

    /* Module Tree Styles */
    .module-tree {
      padding: 20px;
      overflow-y: auto;
      height: 100%;
    }

    .module-tree h2 {
      color: #e0e0e0;
      font-size: 16px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .module-tree .view-stats {
      font-size: 12px;
      color: #858585;
      font-weight: normal;
    }

    .tree-container {
      position: relative;
    }

    .module-node {
      position: relative;
      margin-left: 0;
    }

    .module-node.depth-1 { margin-left: 24px; }
    .module-node.depth-2 { margin-left: 48px; }
    .module-node.depth-3 { margin-left: 72px; }
    .module-node.depth-4 { margin-left: 96px; }
    .module-node.depth-5 { margin-left: 120px; }

    .module-node-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      margin: 2px 0;
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
    }

    .module-node-header:hover {
      border-color: #4fc1ff;
      background: #2d2d2d;
    }

    .module-node.expanded > .module-node-header {
      border-color: #4fc1ff;
      background: #2a3540;
    }

    .module-toggle {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: #858585;
      transition: transform 0.2s;
      flex-shrink: 0;
    }

    .module-toggle.has-children {
      color: #4fc1ff;
    }

    .module-node.expanded > .module-node-header .module-toggle {
      transform: rotate(90deg);
    }

    .module-node-name {
      font-size: 14px;
      font-weight: 500;
      color: #e0e0e0;
    }

    .module-node-path {
      font-size: 11px;
      color: #666;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
    }

    .module-node-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      background: #3c3c3c;
      color: #858585;
      margin-left: auto;
    }

    .module-children {
      display: none;
      position: relative;
    }

    .module-node.expanded > .module-children {
      display: block;
    }

    /* Tree lines */
    .module-children::before {
      content: '';
      position: absolute;
      left: 18px;
      top: 0;
      bottom: 12px;
      width: 1px;
      background: #3c3c3c;
    }

    .module-node::before {
      content: '';
      position: absolute;
      left: -6px;
      top: 18px;
      width: 12px;
      height: 1px;
      background: #3c3c3c;
    }

    .module-node.depth-0::before {
      display: none;
    }

    /* Module details panel (shows when clicking module name) */
    .module-details {
      display: none;
      margin: 8px 0 8px 24px;
      padding: 12px;
      background: #1e1e1e;
      border-radius: 6px;
      border: 1px solid #3c3c3c;
    }

    .module-node.show-details > .module-details {
      display: block;
    }

    .module-description {
      font-size: 12px;
      color: #858585;
      margin-bottom: 12px;
      line-height: 1.4;
    }

    .module-members-header {
      font-size: 11px;
      color: #666;
      text-transform: uppercase;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .module-members-toggle {
      color: #4fc1ff;
      cursor: pointer;
      font-size: 10px;
    }

    .module-members-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 250px;
      overflow-y: auto;
    }

    .module-member {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      background: #252526;
      border-radius: 4px;
      font-size: 12px;
    }

    .module-member-kind {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 3px;
      font-weight: 500;
      min-width: 50px;
      text-align: center;
    }

    .module-member-name {
      color: #d4d4d4;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
    }

    .module-member-file {
      color: #666;
      margin-left: auto;
      font-size: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>ATS Symbol Graph</h1>
      <div class="view-toggle">
        <button class="view-btn active" data-view="force">Force</button>
        <button class="view-btn" data-view="sunburst">Hierarchy</button>
        <button class="view-btn" data-view="modules">Modules</button>
        <button class="view-btn" data-view="flows">Flows</button>
      </div>
      <div class="relationship-filters" id="relationship-filters">
        <span style="color: #858585; font-size: 11px;">Group by:</span>
        <div class="filter-chip active" data-type="structure">
          <span class="chip-dot" style="background: #6a9955;"></span>
          <span>files</span>
        </div>
        <div class="filter-chip" data-type="extends">
          <span class="chip-dot" style="background: #4a9eff;"></span>
          <span>extends</span>
        </div>
        <div class="filter-chip" data-type="implements">
          <span class="chip-dot" style="background: #4ad4d4;"></span>
          <span>implements</span>
        </div>
        <div class="filter-chip" data-type="calls">
          <span class="chip-dot" style="background: #ce9178;"></span>
          <span>calls</span>
        </div>
        <div class="filter-chip" data-type="imports">
          <span class="chip-dot" style="background: #9178ce;"></span>
          <span>imports</span>
        </div>
        <div class="filter-chip" data-type="uses">
          <span class="chip-dot" style="background: #858585;"></span>
          <span>uses</span>
        </div>
      </div>
      <div class="stats" id="stats">
        <span class="stat">Symbols: <span class="stat-value" id="stat-symbols">-</span></span>
        <span class="stat">Annotated: <span class="stat-value annotated" id="stat-annotated">-</span></span>
        <span class="stat">Relationships: <span class="stat-value" id="stat-relationships">-</span></span>
      </div>
    </header>

    <div class="graph-container" id="graph-container">
      <svg id="graph-svg"></svg>
      <div class="loading" id="loading">Loading symbol graph...</div>
    </div>

    <div class="legend" id="legend">
      <div class="legend-title">Symbol Types</div>
      <div class="legend-item">
        <div class="legend-circle" style="background: #3d5a80;"></div>
        <span>function</span>
      </div>
      <div class="legend-item">
        <div class="legend-circle" style="background: #5a3d80;"></div>
        <span>class</span>
      </div>
      <div class="legend-item">
        <div class="legend-circle" style="background: #3d8050;"></div>
        <span>interface</span>
      </div>
      <div class="legend-item">
        <div class="legend-circle" style="background: #806a3d;"></div>
        <span>type</span>
      </div>
      <div class="legend-item">
        <div class="legend-circle greyed" style="background: #666;"></div>
        <span>no annotations</span>
      </div>
    </div>
  </div>

  <div class="tooltip" id="tooltip" style="display: none;"></div>

  <script>
    let simulation = null;
    let currentView = 'force';
    let graphData = null;
    let modulesData = null;
    let flowsData = null;

    // Selected hierarchy grouping type ('structure' for file-based, or a relationship type)
    let selectedGrouping = 'structure';

    // Classify relationship by semantic text
    function classifyRelationship(semantic) {
      const s = (semantic || '').toLowerCase();
      if (s.includes('extend')) return 'extends';
      if (s.includes('implement')) return 'implements';
      if (s.includes('call')) return 'calls';
      if (s.includes('import')) return 'imports';
      if (s.includes('use')) return 'uses';
      return 'uses'; // default category
    }

    // Setup filter chip click handlers (single-select / radio style)
    function setupRelationshipFilters() {
      document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const type = chip.dataset.type;
          if (selectedGrouping === type) return; // Already selected

          // Update selection
          selectedGrouping = type;

          // Update chip styles
          document.querySelectorAll('.filter-chip').forEach(c => {
            c.classList.remove('active');
            c.classList.add('inactive');
          });
          chip.classList.remove('inactive');
          chip.classList.add('active');

          // Re-render hierarchy with new grouping
          renderCurrentView();
        });
      });
    }

    // Color scheme for different kinds
    const kindColors = {
      'function': '#3d5a80',
      'class': '#5a3d80',
      'interface': '#3d8050',
      'type': '#806a3d',
      'variable': '#803d3d',
      'const': '#803d3d',
      'enum': '#3d6880',
      'method': '#4a6670'
    };

    // Hierarchy level colors (for directories/files)
    const hierarchyColors = {
      'directory': '#2d4a5a',
      'file': '#3d4a5a'
    };

    // Build hierarchy from flat node list
    // Build hierarchy from file structure
    function buildFileHierarchy(nodes) {
      const root = { name: 'root', children: [], isRoot: true };

      for (const node of nodes) {
        const parts = node.filePath.split('/').filter(p => p);
        let current = root;

        // Navigate/create directory structure
        for (let i = 0; i < parts.length - 1; i++) {
          let child = current.children.find(c => c.name === parts[i] && !c.data);
          if (!child) {
            child = { name: parts[i], children: [], isDirectory: true, depth: i + 1 };
            current.children.push(child);
          }
          current = child;
        }

        // Add file level
        const fileName = parts[parts.length - 1];
        let fileNode = current.children.find(c => c.name === fileName && !c.data);
        if (!fileNode) {
          fileNode = { name: fileName, children: [], isFile: true, depth: parts.length };
          current.children.push(fileNode);
        }

        // Add symbol as leaf
        fileNode.children.push({
          name: node.name,
          value: Math.max(node.lines, 1),
          data: node
        });
      }

      return root;
    }

    // Build hierarchy from relationship type (e.g., extends, calls)
    // If A extends B, then A is shown as a child of B
    function buildRelationshipHierarchy(nodes, edges, relationshipType) {
      const nodeById = new Map(nodes.map(n => [n.id, n]));

      // Filter edges to only include the selected relationship type
      const relevantEdges = edges.filter(e => {
        const type = classifyRelationship(e.semantic);
        return type === relationshipType;
      });

      // Build parent-child map: source -> targets (source depends on/relates to targets)
      // In "A extends B", source=A, target=B, so A is child of B
      const childrenOf = new Map(); // target -> [sources]
      const hasParent = new Set();

      for (const edge of relevantEdges) {
        if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;

        if (!childrenOf.has(edge.target)) {
          childrenOf.set(edge.target, []);
        }
        childrenOf.get(edge.target).push(edge.source);
        hasParent.add(edge.source);
      }

      // Find root nodes (nodes that have children but no parent in this relationship)
      const involvedNodes = new Set();
      for (const edge of relevantEdges) {
        if (nodeById.has(edge.source)) involvedNodes.add(edge.source);
        if (nodeById.has(edge.target)) involvedNodes.add(edge.target);
      }

      const rootIds = [...involvedNodes].filter(id => !hasParent.has(id));

      // Build tree recursively
      const visited = new Set();

      function buildNode(nodeId, depth = 0) {
        if (visited.has(nodeId)) return null; // Prevent cycles
        visited.add(nodeId);

        const node = nodeById.get(nodeId);
        if (!node) return null;

        const children = (childrenOf.get(nodeId) || [])
          .map(childId => buildNode(childId, depth + 1))
          .filter(c => c !== null);

        return {
          name: node.name,
          value: Math.max(node.lines, 1),
          data: node,
          children: children.length > 0 ? children : undefined
        };
      }

      const rootChildren = rootIds
        .map(id => buildNode(id))
        .filter(c => c !== null);

      // If no relationships of this type, show message
      if (rootChildren.length === 0) {
        return {
          name: 'root',
          children: [{
            name: \`No "\${relationshipType}" relationships found\`,
            isMessage: true,
            children: []
          }],
          isRoot: true
        };
      }

      return {
        name: 'root',
        children: rootChildren,
        isRoot: true
      };
    }

    // Get color for hierarchy node
    function getHierarchyColor(d) {
      if (d.data.data) {
        // Symbol node - use kind color
        return kindColors[d.data.data.kind] || '#666';
      } else if (d.data.isFile) {
        return hierarchyColors.file;
      } else if (d.data.isDirectory) {
        return hierarchyColors.directory;
      }
      return '#2d2d2d';
    }

    // Get stroke color based on annotation status
    function getStrokeColor(d) {
      if (d.data.data && d.data.data.hasAnnotations) {
        return '#6a9955';
      }
      return '#3c3c3c';
    }

    // API helper
    async function fetchJSON(url) {
      const res = await fetch(url);
      return res.json();
    }

    // Ensure SVG exists in graph container
    function ensureGraphSVG() {
      const container = document.getElementById('graph-container');
      let svg = document.getElementById('graph-svg');
      if (!svg) {
        container.innerHTML = '<svg id="graph-svg"></svg>';
      }
    }

    // Update stats header with graph data
    function updateGraphStats() {
      if (!graphData) return;
      document.getElementById('stat-symbols').textContent = graphData.stats.totalSymbols;
      document.getElementById('stat-annotated').textContent = graphData.stats.annotatedSymbols;
      document.getElementById('stat-relationships').textContent = graphData.stats.totalRelationships;
    }

    // Render current view
    function renderCurrentView() {
      const filters = document.getElementById('relationship-filters');
      const legend = document.getElementById('legend');

      if (currentView === 'force') {
        if (!graphData || graphData.nodes.length === 0) return;
        ensureGraphSVG();
        renderSymbolGraph(graphData);
        updateLegend('force');
        updateGraphStats();
        filters.classList.remove('visible');
        legend.style.display = 'block';
      } else if (currentView === 'sunburst') {
        if (!graphData || graphData.nodes.length === 0) return;
        ensureGraphSVG();
        renderSunburstGraph(graphData);
        updateLegend('sunburst');
        updateGraphStats();
        filters.classList.add('visible');
        legend.style.display = 'block';
      } else if (currentView === 'modules') {
        renderModulesView();
        filters.classList.remove('visible');
        legend.style.display = 'none';
      } else if (currentView === 'flows') {
        renderFlowsView();
        filters.classList.remove('visible');
        legend.style.display = 'none';
      }
    }

    // Update legend based on view
    function updateLegend(view) {
      const legend = document.getElementById('legend');
      if (view === 'force') {
        legend.innerHTML = \`
          <div class="legend-title">Symbol Types</div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #3d5a80;"></div>
            <span>function</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #5a3d80;"></div>
            <span>class</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #3d8050;"></div>
            <span>interface</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #806a3d;"></div>
            <span>type</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle greyed" style="background: #666;"></div>
            <span>no annotations</span>
          </div>
        \`;
      } else {
        legend.innerHTML = \`
          <div class="legend-title">Structure</div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #2d4a5a;"></div>
            <span>directory</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #3d4a5a;"></div>
            <span>file</span>
          </div>
          <div class="legend-title" style="margin-top: 12px;">Symbols</div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #3d5a80;"></div>
            <span>function</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #5a3d80;"></div>
            <span>class</span>
          </div>
          <div class="legend-item">
            <div class="legend-circle" style="background: #3d8050; border: 2px solid #6a9955;"></div>
            <span>annotated</span>
          </div>
        \`;
      }
    }

    // Initialize
    async function init() {
      try {
        const data = await fetchJSON('/api/graph/symbols');
        graphData = data;

        // Update stats
        document.getElementById('stat-symbols').textContent = data.stats.totalSymbols;
        document.getElementById('stat-annotated').textContent = data.stats.annotatedSymbols;
        document.getElementById('stat-relationships').textContent = data.stats.totalRelationships;

        // Hide loading
        document.getElementById('loading').style.display = 'none';

        if (data.nodes.length === 0) {
          showEmptyState();
          return;
        }

        // Setup view toggle buttons
        document.querySelectorAll('.view-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentView = btn.dataset.view;
            renderCurrentView();
          });
        });

        // Setup relationship filter chips
        setupRelationshipFilters();

        renderCurrentView();
      } catch (error) {
        console.error('Failed to load graph:', error);
        document.getElementById('loading').textContent = 'Failed to load graph';
      }
    }

    function showEmptyState() {
      const container = document.getElementById('graph-container');
      container.innerHTML = \`
        <div class="empty-state">
          <h2>No symbols found</h2>
          <p>Index a codebase to see the symbol graph</p>
        </div>
      \`;
    }

    function renderSymbolGraph(data) {
      const container = document.getElementById('graph-container');
      const width = container.clientWidth;
      const height = container.clientHeight;

      const svg = d3.select('#graph-svg');
      svg.selectAll('*').remove();

      // Create node id lookup
      const nodeById = new Map(data.nodes.map(n => [n.id, n]));

      // Filter valid edges and create link objects
      const links = data.edges
        .filter(e => nodeById.has(e.source) && nodeById.has(e.target))
        .map(e => ({
          source: e.source,
          target: e.target,
          semantic: e.semantic
        }));

      // Define arrow marker
      svg.append('defs').append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '-0 -5 10 10')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .append('path')
        .attr('d', 'M 0,-5 L 10,0 L 0,5')
        .attr('fill', '#4a4a4a');

      // Calculate node radius based on lines (same formula used for rendering)
      const getNodeRadius = (lines) => {
        const minR = 5, maxR = 25;
        const maxLines = 300;
        const normalized = Math.sqrt(Math.min(lines, maxLines)) / Math.sqrt(maxLines);
        return minR + normalized * (maxR - minR);
      };

      // Create simulation with dynamic collision radius
      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(150))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => getNodeRadius(d.lines) + 15));

      // Zoom behavior
      const g = svg.append('g');

      svg.call(d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        }));

      // Draw links
      const link = g.append('g')
        .attr('class', 'links')
        .selectAll('line')
        .data(links)
        .enter()
        .append('line')
        .attr('class', 'link')
        .attr('stroke', '#4a4a4a')
        .attr('stroke-width', 1.5)
        .attr('marker-end', 'url(#arrowhead)');

      // Draw link labels (semantic annotations)
      const linkLabel = g.append('g')
        .attr('class', 'link-labels')
        .selectAll('text')
        .data(links)
        .enter()
        .append('text')
        .attr('class', 'link-label')
        .text(d => {
          // Truncate long labels
          const label = d.semantic || '';
          return label.length > 25 ? label.substring(0, 22) + '...' : label;
        });

      // Draw nodes
      const node = g.append('g')
        .attr('class', 'nodes')
        .selectAll('.node')
        .data(data.nodes)
        .enter()
        .append('g')
        .attr('class', d => 'node' + (d.hasAnnotations ? '' : ' greyed-out'))
        .call(d3.drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended));

      // Calculate node radius based on lines of code (log scale)
      // Min: 5px, Max: 25px
      const getRadius = (lines) => {
        const minR = 5, maxR = 25;
        const minLines = 1, maxLines = 300;
        // Use sqrt for more visible differentiation
        const normalized = Math.sqrt(Math.min(lines, maxLines)) / Math.sqrt(maxLines);
        return minR + normalized * (maxR - minR);
      };

      // Node circles
      node.append('circle')
        .attr('r', d => getRadius(d.lines))
        .attr('fill', d => kindColors[d.kind] || '#666')
        .attr('stroke', d => d.hasAnnotations ? '#6a9955' : '#3c3c3c')
        .attr('stroke-width', d => d.hasAnnotations ? 2 : 1.5);

      // Node labels (positioned based on node size)
      node.append('text')
        .attr('dx', d => getRadius(d.lines) + 4)
        .attr('dy', 4)
        .text(d => d.name);

      // Tooltip
      const tooltip = d3.select('#tooltip');

      node.on('mouseover', (event, d) => {
        const domainHtml = d.domain ? \`<div class="domains">\${d.domain.map(dom => '<span class="domain-tag">' + dom + '</span>').join('')}</div>\` : '';
        const pureHtml = d.pure !== undefined ? \`<div class="pure \${d.pure ? 'is-pure' : 'has-side-effects'}">\${d.pure ? 'Pure function' : 'Has side effects'}</div>\` : '';
        const purposeHtml = d.purpose ? \`<div class="purpose">\${d.purpose}</div>\` : '';

        tooltip.style('display', 'block')
          .html(\`
            <div class="name">\${d.name}</div>
            <span class="kind kind-\${d.kind}">\${d.kind}</span>
            <span class="lines">\${d.lines} lines</span>
            \${domainHtml}
            \${pureHtml}
            \${purposeHtml}
            <div class="location">\${d.filePath.split('/').slice(-2).join('/')}</div>
          \`);
      })
      .on('mousemove', (event) => {
        tooltip.style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px');
      })
      .on('mouseout', () => {
        tooltip.style('display', 'none');
      });

      // Link hover for semantic labels
      link.on('mouseover', (event, d) => {
        tooltip.style('display', 'block')
          .html(\`
            <div class="name">\${nodeById.get(d.source.id)?.name || d.source} → \${nodeById.get(d.target.id)?.name || d.target}</div>
            <div class="semantic">\${d.semantic}</div>
          \`);
      })
      .on('mousemove', (event) => {
        tooltip.style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px');
      })
      .on('mouseout', () => {
        tooltip.style('display', 'none');
      });

      // Update positions on tick
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        linkLabel
          .attr('x', d => (d.source.x + d.target.x) / 2)
          .attr('y', d => (d.source.y + d.target.y) / 2);

        node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
      });

      function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      }

      function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
      }

      function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }
    }

    // Tidy Tree visualization
    function renderSunburstGraph(data) {
      const container = document.getElementById('graph-container');
      const width = container.clientWidth;
      const height = container.clientHeight;

      // Stop any running force simulation
      if (simulation) {
        simulation.stop();
        simulation = null;
      }

      const svg = d3.select('#graph-svg');
      svg.selectAll('*').remove();

      // Build hierarchy based on selected grouping
      const hierarchyData = selectedGrouping === 'structure'
        ? buildFileHierarchy(data.nodes)
        : buildRelationshipHierarchy(data.nodes, data.edges, selectedGrouping);
      const root = d3.hierarchy(hierarchyData);

      // Count descendants for sizing
      root.count();

      // Sort children by size for better layout
      root.sort((a, b) => b.value - a.value);

      // Calculate tree dimensions based on node count
      const nodeCount = root.descendants().length;
      const dx = 20; // Vertical spacing between nodes
      const dy = Math.max(120, width / (root.height + 1)); // Horizontal spacing

      // Create tree layout
      const treeLayout = d3.tree()
        .nodeSize([dx, dy])
        .separation((a, b) => a.parent === b.parent ? 1 : 1.5);

      treeLayout(root);

      // Calculate bounds
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      root.each(d => {
        if (d.x < x0) x0 = d.x;
        if (d.x > x1) x1 = d.x;
        if (d.y < y0) y0 = d.y;
        if (d.y > y1) y1 = d.y;
      });

      const treeHeight = x1 - x0 + dx * 2;
      const treeWidth = y1 - y0 + dy;

      // Create main group with zoom
      const g = svg.append('g');

      // Set up zoom behavior
      const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });

      svg.call(zoom);

      // Initial transform to center and fit
      const scale = Math.min(
        (width - 100) / treeWidth,
        (height - 100) / treeHeight,
        1
      );
      const initialX = 50 - y0 * scale;
      const initialY = (height / 2) - ((x0 + x1) / 2) * scale;

      svg.call(zoom.transform, d3.zoomIdentity
        .translate(initialX, initialY)
        .scale(scale));

      // Create node ID lookup for relationships
      const nodeById = new Map(data.nodes.map(n => [n.id, n]));

      // Draw links
      const linkGenerator = d3.linkHorizontal()
        .x(d => d.y)
        .y(d => d.x);

      g.selectAll('.tree-link')
        .data(root.links())
        .enter()
        .append('path')
        .attr('class', 'tree-link')
        .attr('d', linkGenerator);

      // Draw nodes
      const node = g.selectAll('.tree-node')
        .data(root.descendants())
        .enter()
        .append('g')
        .attr('class', d => {
          let cls = 'tree-node';
          if (d.children && d.data.isDirectory) cls += ' has-children';
          return cls;
        })
        .attr('transform', d => \`translate(\${d.y},\${d.x})\`);

      // Node circles - size based on type
      node.append('circle')
        .attr('r', d => {
          if (d.data.data) {
            // Symbol node - size by lines of code
            const lines = d.data.data.lines || 1;
            const minR = 4, maxR = 12;
            const normalized = Math.sqrt(Math.min(lines, 300)) / Math.sqrt(300);
            return minR + normalized * (maxR - minR);
          } else if (d.data.isFile) {
            return 5;
          } else if (d.data.isRoot) {
            return 8;
          }
          return 6; // Directory
        })
        .attr('fill', d => getHierarchyColor(d))
        .attr('stroke', d => getStrokeColor(d))
        .attr('stroke-width', d => d.data.data?.hasAnnotations ? 2 : 1);

      // Node labels
      node.append('text')
        .attr('dy', '0.31em')
        .attr('x', d => d.children ? -10 : 10)
        .attr('text-anchor', d => d.children ? 'end' : 'start')
        .text(d => {
          const name = d.data.name;
          // Truncate long names
          return name.length > 25 ? name.substring(0, 22) + '...' : name;
        })
        .clone(true).lower()
        .attr('stroke', '#1e1e1e')
        .attr('stroke-width', 3);

      // Tooltip
      const tooltip = d3.select('#tooltip');

      node.on('mouseover', (event, d) => {
        if (d.data.data) {
          // Symbol node
          const sym = d.data.data;
          const domainHtml = sym.domain ? \`<div class="domains">\${sym.domain.map(dom => '<span class="domain-tag">' + dom + '</span>').join('')}</div>\` : '';
          const pureHtml = sym.pure !== undefined ? \`<div class="pure \${sym.pure ? 'is-pure' : 'has-side-effects'}">\${sym.pure ? 'Pure function' : 'Has side effects'}</div>\` : '';
          const purposeHtml = sym.purpose ? \`<div class="purpose">\${sym.purpose}</div>\` : '';

          tooltip.style('display', 'block')
            .html(\`
              <div class="name">\${sym.name}</div>
              <span class="kind kind-\${sym.kind}">\${sym.kind}</span>
              <span class="lines">\${sym.lines} lines</span>
              \${domainHtml}
              \${pureHtml}
              \${purposeHtml}
              <div class="location">\${sym.filePath.split('/').slice(-2).join('/')}</div>
            \`);
        } else if (!d.data.isRoot) {
          // Directory or file node
          const childCount = d.descendants().filter(c => c.data.data).length;
          const totalLines = d.descendants()
            .filter(c => c.data.data)
            .reduce((sum, c) => sum + (c.data.data.lines || 0), 0);
          const type = d.data.isFile ? 'file' : 'directory';

          tooltip.style('display', 'block')
            .html(\`
              <div class="name">\${d.data.name}</div>
              <span class="kind kind-type">\${type}</span>
              <span class="lines">\${totalLines} lines</span>
              <div class="location">\${childCount} symbols</div>
            \`);
        }
      })
      .on('mousemove', (event) => {
        tooltip.style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px');
      })
      .on('mouseout', () => {
        tooltip.style('display', 'none');
      });
    }

    // Render Modules View as hierarchical tree
    async function renderModulesView() {
      const container = document.getElementById('graph-container');

      // Stop any running simulation
      if (simulation) {
        simulation.stop();
        simulation = null;
      }

      // Always clear cache to ensure fresh data
      modulesData = null;

      // Fetch modules data if not cached
      if (!modulesData) {
        try {
          modulesData = await fetchJSON('/api/modules');
        } catch (error) {
          console.error('Failed to load modules:', error);
          container.innerHTML = '<div class="empty-state"><h2>Failed to load modules</h2></div>';
          return;
        }
      }

      // Update stats header
      document.getElementById('stat-symbols').textContent = modulesData.stats.assigned + ' assigned';
      document.getElementById('stat-annotated').textContent = modulesData.stats.moduleCount + ' modules';
      document.getElementById('stat-relationships').textContent = modulesData.stats.unassigned + ' unassigned';

      if (modulesData.modules.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <h2>No modules found</h2>
            <p>Run 'ats llm modules' to detect modules</p>
          </div>
        \`;
        return;
      }

      // Build tree structure from flat modules using parentId
      const moduleMap = new Map();
      for (const m of modulesData.modules) {
        moduleMap.set(m.id, { ...m, children: [] });
      }

      const roots = [];
      for (const m of moduleMap.values()) {
        if (m.parentId === null) {
          roots.push(m);
        } else {
          const parent = moduleMap.get(m.parentId);
          if (parent) {
            parent.children.push(m);
          } else {
            // Orphan module - treat as root
            roots.push(m);
          }
        }
      }

      // Sort children by name at each level
      function sortChildren(node) {
        node.children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of node.children) {
          sortChildren(child);
        }
      }
      roots.sort((a, b) => a.name.localeCompare(b.name));
      for (const root of roots) {
        sortChildren(root);
      }

      // Render tree HTML
      function renderTreeNode(module, depth = 0) {
        const hasChildren = module.children.length > 0;
        const depthClass = 'depth-' + Math.min(depth, 5);
        const isRoot = depth === 0;

        const membersHtml = module.members.map(m => \`
          <div class="module-member">
            <span class="module-member-kind kind-\${m.kind}">\${m.kind}</span>
            <span class="module-member-name">\${m.name}</span>
            <span class="module-member-file">\${m.filePath.split('/').slice(-1)[0]}:\${m.line}</span>
          </div>
        \`).join('');

        const childrenHtml = module.children.map(child => renderTreeNode(child, depth + 1)).join('');

        return \`
          <div class="module-node \${depthClass}\${isRoot && hasChildren ? ' expanded' : ''}" data-module-id="\${module.id}">
            <div class="module-node-header">
              <span class="module-toggle \${hasChildren ? 'has-children' : ''}">
                \${hasChildren ? '▶' : '○'}
              </span>
              <span class="module-node-name">\${module.name}</span>
              <span class="module-node-path">\${module.fullPath}</span>
              <span class="module-node-badge">\${module.memberCount}</span>
            </div>
            <div class="module-details">
              \${module.description ? \`<div class="module-description">\${module.description}</div>\` : ''}
              \${module.members.length > 0 ? \`
                <div class="module-members-header">
                  Members (\${module.memberCount})
                </div>
                <div class="module-members-list">\${membersHtml}</div>
              \` : '<div class="module-members-header">No direct members</div>'}
            </div>
            \${hasChildren ? \`<div class="module-children">\${childrenHtml}</div>\` : ''}
          </div>
        \`;
      }

      const treeHtml = roots.map(root => renderTreeNode(root, 0)).join('');

      container.innerHTML = \`
        <div class="module-tree">
          <h2>
            Module Tree
            <span class="view-stats">\${modulesData.stats.moduleCount} modules, \${modulesData.stats.assigned} symbols assigned</span>
          </h2>
          <div class="tree-container">\${treeHtml}</div>
        </div>
      \`;

      // Add event listeners for tree interactions
      container.querySelectorAll('.module-node-header').forEach(header => {
        header.addEventListener('click', (e) => {
          const node = header.closest('.module-node');
          const toggle = header.querySelector('.module-toggle');
          const hasChildren = toggle.classList.contains('has-children');

          if (hasChildren) {
            // Any click on header toggles expand for nodes with children
            node.classList.toggle('expanded');
          }
          // Always allow showing details too
          node.classList.toggle('show-details');
        });
      });
    }

    // Render Flows View
    async function renderFlowsView() {
      const container = document.getElementById('graph-container');

      // Stop any running simulation
      if (simulation) {
        simulation.stop();
        simulation = null;
      }

      // Fetch flows data if not cached
      if (!flowsData) {
        try {
          flowsData = await fetchJSON('/api/flows');
        } catch (error) {
          console.error('Failed to load flows:', error);
          container.innerHTML = '<div class="empty-state"><h2>Failed to load flows</h2></div>';
          return;
        }
      }

      // Update stats header
      document.getElementById('stat-symbols').textContent = flowsData.stats.totalSteps + ' steps';
      document.getElementById('stat-annotated').textContent = flowsData.stats.flowCount + ' flows';
      document.getElementById('stat-relationships').textContent = flowsData.stats.modulesCovered + ' modules';

      if (flowsData.flows.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <h2>No flows found</h2>
            <p>Run 'ats llm flows' to detect execution flows</p>
          </div>
        \`;
        return;
      }

      renderFlowsCardsView();
    }

    // Render the cards view for flows
    function renderFlowsCardsView() {
      const container = document.getElementById('graph-container');
      const sortedFlows = [...flowsData.flows].sort((a, b) => b.stepCount - a.stepCount);

      container.innerHTML = \`
        <div class="list-view">
          <h2>
            Execution Flows
            <span class="view-stats">\${flowsData.stats.flowCount} flows, \${flowsData.stats.totalSteps} total steps</span>
          </h2>
          <div class="card-grid" id="flows-grid"></div>
        </div>
      \`;

      const grid = document.getElementById('flows-grid');

      for (const flow of sortedFlows) {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.flowId = flow.id;

        // Build steps HTML
        const stepsHtml = flow.steps.map((step, idx) => \`
          <div class="member-item">
            <span class="step-number">\${idx + 1}</span>
            <span class="member-kind kind-\${step.kind}">\${step.kind}</span>
            <span class="member-name">\${step.name}</span>
            \${step.layer ? \`<span class="card-badge layer-\${step.layer}" style="margin-left: auto; font-size: 9px;">\${step.layer}</span>\` : ''}
          </div>
        \`).join('');

        // Modules crossed tags
        const modulesHtml = flow.modulesCrossed.length > 0
          ? \`<div class="modules-crossed">\${flow.modulesCrossed.map(m => \`<span class="module-tag">\${m}</span>\`).join('')}</div>\`
          : '';

        card.innerHTML = \`
          <div class="card-header">
            <span class="card-title">\${flow.name}</span>
            \${flow.domain ? \`<span class="card-badge layer-service">\${flow.domain}</span>\` : ''}
          </div>
          \${flow.description ? \`<div class="card-description">\${flow.description}</div>\` : ''}
          <div class="card-meta">
            <div class="card-meta-item">
              Entry: <span class="card-meta-value">\${flow.entryPoint.name}</span>
            </div>
            <div class="card-meta-item">
              Steps: <span class="card-meta-value">\${flow.stepCount}</span>
            </div>
          </div>
          \${modulesHtml}
          <div class="card-members">
            <h4>Steps (\${flow.stepCount})</h4>
            <div class="member-list">\${stepsHtml}</div>
          </div>
          <div class="card-dag-container" id="dag-container-\${flow.id}">
            <h4>Flow Graph</h4>
            <div class="card-dag-svg-container">
              <svg id="dag-svg-\${flow.id}"></svg>
              <div class="card-dag-loading" id="dag-loading-\${flow.id}">Loading graph...</div>
            </div>
          </div>
        \`;

        card.addEventListener('click', async () => {
          // Toggle expanded state
          const wasExpanded = card.classList.contains('expanded');
          // Collapse all others
          document.querySelectorAll('.card.expanded').forEach(c => c.classList.remove('expanded'));
          if (!wasExpanded) {
            card.classList.add('expanded');
            // Load and render DAG for this flow
            await renderCardFlowDAG(flow.id);
          }
        });

        grid.appendChild(card);
      }
    }

    // Render a flow DAG within its card container
    async function renderCardFlowDAG(flowId) {
      const container = document.getElementById(\`dag-container-\${flowId}\`);
      const svgContainer = container?.querySelector('.card-dag-svg-container');
      const loading = document.getElementById(\`dag-loading-\${flowId}\`);
      const svg = d3.select(\`#dag-svg-\${flowId}\`);

      if (!container || !svgContainer) return;

      // Clear existing content
      svg.selectAll('*').remove();
      if (loading) loading.style.display = 'block';

      try {
        const dagData = await fetchJSON(\`/api/flows/\${flowId}/dag\`);
        if (loading) loading.style.display = 'none';

        if (!dagData || dagData.nodes.length === 0) {
          svgContainer.innerHTML = '<div class="card-dag-loading">No steps in this flow</div>';
          return;
        }

        const width = svgContainer.clientWidth || 600;
        const height = svgContainer.clientHeight || 280;

        // Create node lookup
        const nodeById = new Map(dagData.nodes.map(n => [n.id, n]));

        // Group nodes by stepOrder for horizontal layout
        const nodesByStep = new Map();
        for (const node of dagData.nodes) {
          const step = node.stepOrder;
          if (!nodesByStep.has(step)) {
            nodesByStep.set(step, []);
          }
          nodesByStep.get(step).push(node);
        }

        // Calculate positions: x by stepOrder, y by position within step
        const stepOrders = [...nodesByStep.keys()].sort((a, b) => a - b);
        const nodeWidth = 120;
        const nodeHeight = 32;
        const horizontalGap = 150;
        const verticalGap = 45;

        const startX = 30;
        const centerY = height / 2;

        // Assign positions to nodes
        const nodePositions = new Map();
        for (const stepOrder of stepOrders) {
          const nodesInStep = nodesByStep.get(stepOrder);
          const stepIndex = stepOrders.indexOf(stepOrder);
          const x = startX + stepIndex * horizontalGap;
          const totalHeight = nodesInStep.length * (nodeHeight + verticalGap) - verticalGap;
          const startY = centerY - totalHeight / 2;

          nodesInStep.forEach((node, idx) => {
            nodePositions.set(node.id, {
              x: x,
              y: startY + idx * (nodeHeight + verticalGap),
              node: node
            });
          });
        }

        // Define arrow marker with unique ID per flow
        svg.append('defs').append('marker')
          .attr('id', \`dag-arrowhead-\${flowId}\`)
          .attr('viewBox', '-0 -5 10 10')
          .attr('refX', 8)
          .attr('refY', 0)
          .attr('orient', 'auto')
          .attr('markerWidth', 6)
          .attr('markerHeight', 6)
          .append('path')
          .attr('d', 'M 0,-3 L 6,0 L 0,3')
          .attr('fill', '#6a6a6a');

        // Create main group with zoom
        const g = svg.append('g');

        // Set up zoom behavior
        const zoom = d3.zoom()
          .scaleExtent([0.3, 2])
          .on('zoom', (event) => {
            g.attr('transform', event.transform);
          });

        svg.call(zoom);

        // Draw edges using curved links
        const linkGenerator = d3.linkHorizontal()
          .x(d => d.x)
          .y(d => d.y);

        const validEdges = dagData.edges.filter(e =>
          nodePositions.has(e.source) && nodePositions.has(e.target)
        );

        g.selectAll('.dag-link')
          .data(validEdges)
          .enter()
          .append('path')
          .attr('class', 'dag-link')
          .attr('d', d => {
            const source = nodePositions.get(d.source);
            const target = nodePositions.get(d.target);
            return linkGenerator({
              source: { x: source.x + nodeWidth, y: source.y + nodeHeight / 2 },
              target: { x: target.x, y: target.y + nodeHeight / 2 }
            });
          })
          .attr('marker-end', \`url(#dag-arrowhead-\${flowId})\`);

        // Draw nodes
        const node = g.selectAll('.dag-node')
          .data(dagData.nodes)
          .enter()
          .append('g')
          .attr('class', d => {
            const layer = d.layer || 'default';
            const isEntry = d.isEntryPoint ? ' entry-point' : '';
            return \`dag-node layer-\${layer}\${isEntry}\`;
          })
          .attr('transform', d => {
            const pos = nodePositions.get(d.id);
            return \`translate(\${pos.x}, \${pos.y})\`;
          });

        // Node rectangles
        node.append('rect')
          .attr('width', nodeWidth)
          .attr('height', nodeHeight);

        // Node text (name)
        node.append('text')
          .attr('x', nodeWidth / 2)
          .attr('y', nodeHeight / 2 + 3)
          .attr('text-anchor', 'middle')
          .style('font-size', '10px')
          .text(d => {
            const name = d.name;
            return name.length > 14 ? name.substring(0, 12) + '...' : name;
          });

        // Entry point badge
        node.filter(d => d.isEntryPoint)
          .append('text')
          .attr('class', 'entry-badge')
          .attr('x', nodeWidth / 2)
          .attr('y', -4)
          .attr('text-anchor', 'middle')
          .style('font-size', '8px')
          .text('ENTRY');

        // Tooltip
        const tooltip = d3.select('#tooltip');

        node.on('mouseover', (event, d) => {
          event.stopPropagation();
          const layerHtml = d.layer ? \`<span class="card-badge layer-\${d.layer}">\${d.layer}</span>\` : '';
          const moduleHtml = d.moduleName ? \`<div class="module-tag" style="margin-top: 4px;">\${d.moduleName}</div>\` : '';

          tooltip.style('display', 'block')
            .html(\`
              <div class="name">\${d.name}</div>
              <span class="kind kind-\${d.kind}">\${d.kind}</span>
              \${layerHtml}
              \${moduleHtml}
              <div class="location">\${d.filePath.split('/').slice(-2).join('/')}</div>
            \`);
        })
        .on('mousemove', (event) => {
          event.stopPropagation();
          tooltip.style('left', (event.pageX + 10) + 'px')
            .style('top', (event.pageY - 10) + 'px');
        })
        .on('mouseout', (event) => {
          event.stopPropagation();
          tooltip.style('display', 'none');
        });

        // Prevent clicks on DAG from closing the card
        svgContainer.addEventListener('click', (e) => e.stopPropagation());

        // Calculate bounds and center view
        const allX = [...nodePositions.values()].map(p => p.x);
        const allY = [...nodePositions.values()].map(p => p.y);
        const minX = Math.min(...allX);
        const maxX = Math.max(...allX) + nodeWidth;
        const minY = Math.min(...allY);
        const maxY = Math.max(...allY) + nodeHeight;

        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;

        // Fit to view with some padding
        const scale = Math.min(
          (width - 60) / contentWidth,
          (height - 40) / contentHeight,
          1.2
        );
        const translateX = (width - contentWidth * scale) / 2 - minX * scale;
        const translateY = (height - contentHeight * scale) / 2 - minY * scale;

        svg.call(zoom.transform, d3.zoomIdentity
          .translate(translateX, translateY)
          .scale(scale));

      } catch (error) {
        console.error('Failed to load flow DAG:', error);
        if (loading) loading.style.display = 'none';
        svgContainer.innerHTML = '<div class="card-dag-loading">Failed to load graph</div>';
      }
    }

    // Start
    init();
  </script>
</body>
</html>`;
}
