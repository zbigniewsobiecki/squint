import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexDatabase } from '../db/database.js';
import {
  getContractsData,
  getFlowsDagData,
  getFlowsData,
  getInteractionsData,
  getModulesData,
  getProcessGroupsData,
  getSymbolGraph,
} from './api-transforms.js';

// Calculate UI dist path relative to this file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST_PATH = path.resolve(__dirname, '../../ui/dist');

// MIME types for static files
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Get MIME type for a file extension
 */
export function getMimeType(ext: string): string {
  return MIME_TYPES[ext] || 'application/octet-stream';
}

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
      // Route handling - API routes first
      if (path === '/api/stats') {
        jsonResponse(res, db.getStats());
      } else if (path === '/api/files') {
        jsonResponse(res, db.files.getAll());
      } else if (path.match(/^\/api\/files\/(\d+)$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const file = db.files.getById(id);
        if (file) {
          const definitions = db.definitions.getForFile(id);
          const imports = db.files.getImports(id);
          jsonResponse(res, { ...file, definitions, imports });
        } else {
          notFound(res, 'File not found');
        }
      } else if (path === '/api/definitions') {
        const kind = url.searchParams.get('kind') || undefined;
        const exportedParam = url.searchParams.get('exported');
        const exported = exportedParam === null ? undefined : exportedParam === 'true';
        jsonResponse(res, db.definitions.getAll({ kind, exported }));
      } else if (path.match(/^\/api\/definitions\/(\d+)$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const def = db.definitions.getById(id);
        if (def) {
          jsonResponse(res, def);
        } else {
          notFound(res, 'Definition not found');
        }
      } else if (path.match(/^\/api\/definitions\/(\d+)\/callsites$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const callsites = db.dependencies.getCallsites(id);
        jsonResponse(res, callsites);
      } else if (path === '/api/graph/imports') {
        jsonResponse(res, db.dependencies.getImportGraph());
      } else if (path === '/api/graph/classes') {
        jsonResponse(res, db.definitions.getClassHierarchy());
      } else if (path === '/api/graph/symbols') {
        jsonResponse(res, getSymbolGraph(db));
      } else if (path === '/api/modules') {
        jsonResponse(res, getModulesData(db));
      } else if (path === '/api/modules/stats') {
        jsonResponse(res, db.modules.getStats());
      } else if (path.match(/^\/api\/modules\/(\d+)$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const module = db.modules.getWithMembers(id);
        if (module) {
          jsonResponse(res, module);
        } else {
          notFound(res, 'Module not found');
        }
      } else if (path === '/api/process-groups') {
        jsonResponse(res, getProcessGroupsData(db));
      } else if (path === '/api/interactions') {
        jsonResponse(res, getInteractionsData(db));
      } else if (path === '/api/interactions/stats') {
        jsonResponse(res, db.interactions.getStats());
      } else if (path.match(/^\/api\/interactions\/(\d+)$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const interaction = db.interactions.getById(id);
        if (interaction) {
          const modules = db.modules.getAll();
          const moduleMap = new Map(modules.map((m) => [m.id, m.fullPath]));
          jsonResponse(res, {
            ...interaction,
            fromModulePath: moduleMap.get(interaction.fromModuleId) ?? null,
            toModulePath: moduleMap.get(interaction.toModuleId) ?? null,
          });
        } else {
          notFound(res, 'Interaction not found');
        }
      } else if (path === '/api/contracts') {
        jsonResponse(res, getContractsData(db));
      } else if (path === '/api/flows') {
        jsonResponse(res, getFlowsData(db));
      } else if (path === '/api/flows/stats') {
        jsonResponse(res, db.flows.getStats());
      } else if (path === '/api/flows/coverage') {
        const coverage = db.flows.getCoverage();
        jsonResponse(res, coverage);
      } else if (path === '/api/flows/dag') {
        jsonResponse(res, getFlowsDagData(db));
      } else if (path.match(/^\/api\/flows\/(\d+)$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const flowWithSteps = db.flows.getWithSteps(id);
        if (flowWithSteps) {
          jsonResponse(res, flowWithSteps);
        } else {
          notFound(res, 'Flow not found');
        }
      } else if (path.match(/^\/api\/flows\/(\d+)\/expand$/)) {
        const id = Number.parseInt(path.split('/')[3]);
        const expanded = db.flows.expand(id);
        jsonResponse(res, expanded);
      } else {
        // Serve static files from ui/dist
        serveStatic(res, path);
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

/**
 * Serve static files from ui/dist
 */
function serveStatic(res: http.ServerResponse, urlPath: string): void {
  // Map / to /index.html
  const filePath = urlPath === '/' ? '/index.html' : urlPath;

  // Resolve to actual file path
  const fullPath = path.join(UI_DIST_PATH, filePath);

  // Security check - prevent directory traversal
  if (!fullPath.startsWith(UI_DIST_PATH)) {
    notFound(res, 'Not found');
    return;
  }

  // Check if file exists
  if (!fs.existsSync(fullPath)) {
    // For SPA routing, serve index.html for non-existent paths
    const indexPath = path.join(UI_DIST_PATH, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
      return;
    }
    notFound(res, 'Not found');
    return;
  }

  // Get MIME type
  const ext = path.extname(fullPath);
  const mimeType = getMimeType(ext);

  // Read and serve file
  const content = fs.readFileSync(fullPath);
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(content);
}
