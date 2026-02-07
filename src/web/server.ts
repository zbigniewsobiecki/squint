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
    },
  };
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
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>ATS Symbol Graph</h1>
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

    <div class="legend">
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

    // API helper
    async function fetchJSON(url) {
      const res = await fetch(url);
      return res.json();
    }

    // Initialize
    async function init() {
      try {
        const data = await fetchJSON('/api/graph/symbols');

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

        renderSymbolGraph(data);
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

    // Start
    init();
  </script>
</body>
</html>`;
}
