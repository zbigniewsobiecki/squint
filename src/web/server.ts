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

function getEmbeddedHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATS Code Browser</title>
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

    /* Tab Navigation */
    .tabs {
      display: flex;
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      padding: 0 16px;
    }

    .tab {
      padding: 10px 16px;
      cursor: pointer;
      color: #858585;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }

    .tab:hover {
      color: #d4d4d4;
    }

    .tab.active {
      color: #e0e0e0;
      border-bottom-color: #007acc;
    }

    /* Main Content */
    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: 300px;
      background: #252526;
      border-right: 1px solid #3c3c3c;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 12px 16px;
      border-bottom: 1px solid #3c3c3c;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sidebar-header h2 {
      font-size: 14px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #858585;
    }

    .search-box {
      padding: 8px 16px;
      border-bottom: 1px solid #3c3c3c;
    }

    .search-box input {
      width: 100%;
      padding: 6px 10px;
      background: #3c3c3c;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      color: #d4d4d4;
      font-size: 13px;
    }

    .search-box input:focus {
      outline: none;
      border-color: #007acc;
    }

    .sidebar-content {
      flex: 1;
      overflow-y: auto;
    }

    /* File Tree */
    .tree-item {
      padding: 6px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tree-item:hover {
      background: #2a2d2e;
    }

    .tree-item.selected {
      background: #094771;
    }

    .tree-item .icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .tree-item.folder > .icon {
      color: #dcb67a;
    }

    .tree-item.file > .icon {
      color: #519aba;
    }

    .tree-children {
      display: none;
    }

    .tree-children.expanded {
      display: block;
    }

    .tree-item.folder .toggle {
      width: 16px;
      text-align: center;
      color: #858585;
    }

    /* Definition list in sidebar */
    .definition-item {
      padding: 6px 16px 6px 24px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .definition-item:hover {
      background: #2a2d2e;
    }

    .definition-item .kind {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 500;
    }

    .kind-function { background: #3d5a80; color: #a8d0e6; }
    .kind-class { background: #5a3d80; color: #d0a8e6; }
    .kind-interface { background: #3d8050; color: #a8e6b4; }
    .kind-type { background: #806a3d; color: #e6d4a8; }
    .kind-variable, .kind-const { background: #803d3d; color: #e6a8a8; }
    .kind-enum { background: #3d6880; color: #a8cce6; }

    .definition-item .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .definition-item .exported {
      color: #6a9955;
      font-size: 11px;
    }

    /* Visualization Area */
    .visualization {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .viz-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .viz-container svg {
      width: 100%;
      height: 100%;
    }

    /* Graph Styles */
    .node circle {
      stroke: #3c3c3c;
      stroke-width: 2px;
      cursor: pointer;
    }

    .node text {
      font-size: 11px;
      fill: #d4d4d4;
      pointer-events: none;
    }

    .link {
      stroke: #4a4a4a;
      stroke-opacity: 0.6;
      fill: none;
    }

    .link.extends {
      stroke: #4fc1ff;
    }

    .link.implements {
      stroke: #6a9955;
      stroke-dasharray: 4 2;
    }

    .link.import {
      stroke: #ce9178;
    }

    /* Details Panel */
    .details-panel {
      height: 200px;
      background: #252526;
      border-top: 1px solid #3c3c3c;
      overflow-y: auto;
      padding: 16px;
    }

    .details-panel h3 {
      font-size: 14px;
      margin-bottom: 12px;
      color: #e0e0e0;
    }

    .details-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px 16px;
      font-size: 13px;
    }

    .details-label {
      color: #858585;
    }

    .details-value {
      color: #d4d4d4;
    }

    .details-value a {
      color: #4fc1ff;
      text-decoration: none;
    }

    .details-value a:hover {
      text-decoration: underline;
    }

    /* Breadcrumb */
    .breadcrumb {
      padding: 8px 16px;
      background: #252526;
      border-top: 1px solid #3c3c3c;
      font-size: 13px;
      color: #858585;
    }

    .breadcrumb span {
      color: #4fc1ff;
      cursor: pointer;
    }

    .breadcrumb span:hover {
      text-decoration: underline;
    }

    /* Loading & Empty states */
    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #858585;
      font-size: 14px;
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
      max-width: 300px;
    }

    .tooltip .name {
      font-weight: 600;
      color: #e0e0e0;
    }

    .tooltip .kind {
      color: #4fc1ff;
      font-size: 11px;
    }

    .tooltip .location {
      color: #858585;
      font-size: 11px;
      margin-top: 4px;
    }

    /* Callsites list */
    .callsites-list {
      margin-top: 12px;
    }

    .callsite-item {
      padding: 4px 0;
      font-size: 12px;
      color: #d4d4d4;
    }

    .callsite-item .file {
      color: #4fc1ff;
    }

    .callsite-item .line {
      color: #858585;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>ATS Code Browser</h1>
      <div class="stats" id="stats">
        <span class="stat">Files: <span class="stat-value" id="stat-files">-</span></span>
        <span class="stat">Definitions: <span class="stat-value" id="stat-definitions">-</span></span>
        <span class="stat">Imports: <span class="stat-value" id="stat-imports">-</span></span>
        <span class="stat">Usages: <span class="stat-value" id="stat-usages">-</span></span>
      </div>
    </header>

    <div class="tabs">
      <div class="tab active" data-tab="files">Files</div>
      <div class="tab" data-tab="definitions">Definitions</div>
      <div class="tab" data-tab="imports">Import Graph</div>
      <div class="tab" data-tab="classes">Class Hierarchy</div>
    </div>

    <div class="main">
      <div class="sidebar">
        <div class="sidebar-header">
          <h2 id="sidebar-title">Files</h2>
        </div>
        <div class="search-box">
          <input type="text" id="search" placeholder="Search...">
        </div>
        <div class="sidebar-content" id="sidebar-content">
          <div class="loading">Loading...</div>
        </div>
      </div>

      <div class="visualization">
        <div class="viz-container" id="viz-container">
          <svg id="viz-svg"></svg>
        </div>
        <div class="details-panel" id="details-panel">
          <div class="empty">Select an item to view details</div>
        </div>
      </div>
    </div>

    <div class="breadcrumb" id="breadcrumb">
      <span data-path="">Home</span>
    </div>
  </div>

  <div class="tooltip" id="tooltip" style="display: none;"></div>

  <script>
    // State
    let currentTab = 'files';
    let files = [];
    let definitions = [];
    let selectedItem = null;
    let simulation = null;

    // API helpers
    async function fetchJSON(url) {
      const res = await fetch(url);
      return res.json();
    }

    // Initialize
    async function init() {
      const stats = await fetchJSON('/api/stats');
      document.getElementById('stat-files').textContent = stats.files;
      document.getElementById('stat-definitions').textContent = stats.definitions;
      document.getElementById('stat-imports').textContent = stats.imports;
      document.getElementById('stat-usages').textContent = stats.usages;

      files = await fetchJSON('/api/files');
      definitions = await fetchJSON('/api/definitions');

      setupTabs();
      setupSearch();
      showTab('files');
    }

    // Tab handling
    function setupTabs() {
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          showTab(tab.dataset.tab);
        });
      });
    }

    function showTab(tab) {
      currentTab = tab;
      const sidebar = document.getElementById('sidebar-content');
      const viz = document.getElementById('viz-container');

      // Stop any running simulation
      if (simulation) {
        simulation.stop();
        simulation = null;
      }

      switch (tab) {
        case 'files':
          document.getElementById('sidebar-title').textContent = 'Files';
          renderFileTree(sidebar);
          clearVisualization();
          break;
        case 'definitions':
          document.getElementById('sidebar-title').textContent = 'Definitions';
          renderDefinitionList(sidebar);
          clearVisualization();
          break;
        case 'imports':
          document.getElementById('sidebar-title').textContent = 'Import Graph';
          renderFileList(sidebar);
          renderImportGraph();
          break;
        case 'classes':
          document.getElementById('sidebar-title').textContent = 'Class Hierarchy';
          renderClassList(sidebar);
          renderClassHierarchy();
          break;
      }
    }

    // Search
    function setupSearch() {
      const searchInput = document.getElementById('search');
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        filterSidebar(query);
      });
    }

    function filterSidebar(query) {
      const items = document.querySelectorAll('.sidebar-content .tree-item, .sidebar-content .definition-item');
      items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(query) ? '' : 'none';
      });
    }

    // File Tree
    function renderFileTree(container) {
      const tree = buildFileTree(files);
      container.innerHTML = '';
      renderTreeNodes(container, tree, 0);
    }

    function buildFileTree(files) {
      const root = { name: '', children: {}, files: [] };

      files.forEach(file => {
        const parts = file.path.split('/');
        let current = root;

        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          if (!current.children[part]) {
            current.children[part] = { name: part, children: {}, files: [] };
          }
          current = current.children[part];
        }

        current.files.push({ ...file, name: parts[parts.length - 1] });
      });

      return root;
    }

    function renderTreeNodes(container, node, depth) {
      // Sort folders first, then files
      const folders = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
      const nodeFiles = node.files.sort((a, b) => a.name.localeCompare(b.name));

      folders.forEach(folder => {
        const div = document.createElement('div');
        div.className = 'tree-item folder';
        div.style.paddingLeft = (16 + depth * 16) + 'px';
        div.innerHTML = \`
          <span class="toggle">+</span>
          <span class="icon">&#x1F4C1;</span>
          <span>\${folder.name}</span>
        \`;

        const children = document.createElement('div');
        children.className = 'tree-children';
        renderTreeNodes(children, folder, depth + 1);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const toggle = div.querySelector('.toggle');
          if (children.classList.contains('expanded')) {
            children.classList.remove('expanded');
            toggle.textContent = '+';
          } else {
            children.classList.add('expanded');
            toggle.textContent = '-';
          }
        });

        container.appendChild(div);
        container.appendChild(children);
      });

      nodeFiles.forEach(file => {
        const div = document.createElement('div');
        div.className = 'tree-item file';
        div.style.paddingLeft = (32 + depth * 16) + 'px';
        div.innerHTML = \`
          <span class="icon">&#x1F4C4;</span>
          <span>\${file.name}</span>
        \`;
        div.addEventListener('click', () => selectFile(file));
        container.appendChild(div);
      });
    }

    function renderFileList(container) {
      container.innerHTML = '';
      files.forEach(file => {
        const div = document.createElement('div');
        div.className = 'tree-item file';
        div.innerHTML = \`
          <span class="icon">&#x1F4C4;</span>
          <span>\${file.path}</span>
        \`;
        div.addEventListener('click', () => highlightFileInGraph(file.id));
        container.appendChild(div);
      });
    }

    // Definition List
    function renderDefinitionList(container) {
      container.innerHTML = '';
      definitions.forEach(def => {
        const div = document.createElement('div');
        div.className = 'definition-item';
        div.innerHTML = \`
          <span class="kind kind-\${def.kind}">\${def.kind}</span>
          <span class="name">\${def.name}</span>
          \${def.isExported ? '<span class="exported">export</span>' : ''}
        \`;
        div.addEventListener('click', () => selectDefinition(def));
        container.appendChild(div);
      });
    }

    function renderClassList(container) {
      container.innerHTML = '';
      const classes = definitions.filter(d => d.kind === 'class' || d.kind === 'interface');
      classes.forEach(def => {
        const div = document.createElement('div');
        div.className = 'definition-item';
        div.innerHTML = \`
          <span class="kind kind-\${def.kind}">\${def.kind}</span>
          <span class="name">\${def.name}</span>
          \${def.extendsName ? '<span class="exported">: ' + def.extendsName + '</span>' : ''}
        \`;
        div.addEventListener('click', () => highlightClassInGraph(def.id));
        container.appendChild(div);
      });
    }

    // Selection handlers
    async function selectFile(file) {
      selectedItem = file;
      updateBreadcrumb(file.path);

      const details = await fetchJSON('/api/files/' + file.id);
      showFileDetails(details);
    }

    async function selectDefinition(def) {
      selectedItem = def;

      const details = await fetchJSON('/api/definitions/' + def.id);
      const callsites = await fetchJSON('/api/definitions/' + def.id + '/callsites');
      showDefinitionDetails(details, callsites);
      updateBreadcrumb(details.filePath + ':' + details.line);
    }

    // Details Panel
    function showFileDetails(file) {
      const panel = document.getElementById('details-panel');
      let html = \`
        <h3>\${file.path}</h3>
        <div class="details-grid">
          <span class="details-label">Language:</span>
          <span class="details-value">\${file.language}</span>
          <span class="details-label">Size:</span>
          <span class="details-value">\${formatBytes(file.sizeBytes)}</span>
          <span class="details-label">Modified:</span>
          <span class="details-value">\${file.modifiedAt}</span>
          <span class="details-label">Definitions:</span>
          <span class="details-value">\${file.definitions.length}</span>
          <span class="details-label">Imports:</span>
          <span class="details-value">\${file.imports.length}</span>
        </div>
      \`;

      if (file.definitions.length > 0) {
        html += '<h3 style="margin-top: 16px;">Definitions</h3>';
        file.definitions.forEach(def => {
          html += \`
            <div class="definition-item" onclick="selectDefinition({id: \${def.id}})">
              <span class="kind kind-\${def.kind}">\${def.kind}</span>
              <span class="name">\${def.name}</span>
              <span class="details-label">:\${def.line}</span>
            </div>
          \`;
        });
      }

      panel.innerHTML = html;
    }

    function showDefinitionDetails(def, callsites) {
      const panel = document.getElementById('details-panel');
      let html = \`
        <h3>\${def.name}</h3>
        <div class="details-grid">
          <span class="details-label">Kind:</span>
          <span class="details-value"><span class="kind kind-\${def.kind}">\${def.kind}</span></span>
          <span class="details-label">File:</span>
          <span class="details-value"><a href="#" onclick="selectFileById(\${def.fileId})">\${def.filePath}</a></span>
          <span class="details-label">Location:</span>
          <span class="details-value">Line \${def.line}, Column \${def.column}</span>
          <span class="details-label">Exported:</span>
          <span class="details-value">\${def.isExported ? 'Yes' : 'No'}</span>
      \`;

      if (def.extendsName) {
        html += \`
          <span class="details-label">Extends:</span>
          <span class="details-value">\${def.extendsName}</span>
        \`;
      }

      if (def.implementsNames && def.implementsNames.length > 0) {
        html += \`
          <span class="details-label">Implements:</span>
          <span class="details-value">\${def.implementsNames.join(', ')}</span>
        \`;
      }

      html += '</div>';

      if (callsites.length > 0) {
        html += \`<h3 style="margin-top: 16px;">Callsites (\${callsites.length})</h3><div class="callsites-list">\`;
        callsites.forEach(cs => {
          html += \`
            <div class="callsite-item">
              <span class="file">\${cs.filePath}</span>:<span class="line">\${cs.line}</span>
              \${cs.receiverName ? '(' + cs.receiverName + '.' + cs.localName + ')' : ''}
            </div>
          \`;
        });
        html += '</div>';
      }

      panel.innerHTML = html;
    }

    async function selectFileById(fileId) {
      const file = files.find(f => f.id === fileId);
      if (file) {
        await selectFile(file);
      }
    }

    // Breadcrumb
    function updateBreadcrumb(path) {
      const bc = document.getElementById('breadcrumb');
      const parts = path.split('/');
      let html = '<span data-path="" onclick="clearSelection()">Home</span>';

      parts.forEach((part, i) => {
        html += ' / <span>' + part + '</span>';
      });

      bc.innerHTML = html;
    }

    function clearSelection() {
      selectedItem = null;
      document.getElementById('details-panel').innerHTML = '<div class="empty">Select an item to view details</div>';
      document.getElementById('breadcrumb').innerHTML = '<span data-path="">Home</span>';
    }

    // Visualization
    function clearVisualization() {
      const svg = d3.select('#viz-svg');
      svg.selectAll('*').remove();
    }

    async function renderImportGraph() {
      const data = await fetchJSON('/api/graph/imports');
      renderForceGraph(data, 'import');
    }

    async function renderClassHierarchy() {
      const data = await fetchJSON('/api/graph/classes');
      if (data.nodes.length === 0) {
        const svg = d3.select('#viz-svg');
        svg.selectAll('*').remove();
        svg.append('text')
          .attr('x', '50%')
          .attr('y', '50%')
          .attr('text-anchor', 'middle')
          .attr('fill', '#858585')
          .text('No classes or interfaces found');
        return;
      }
      renderForceGraph(data, 'hierarchy');
    }

    function renderForceGraph(data, type) {
      const container = document.getElementById('viz-container');
      const width = container.clientWidth;
      const height = container.clientHeight;

      const svg = d3.select('#viz-svg');
      svg.selectAll('*').remove();

      // Create node id lookup for links
      const nodeById = new Map(data.nodes.map(n => [n.id, n]));

      // Filter valid links
      const links = data.links.filter(l => nodeById.has(l.source) && nodeById.has(l.target));

      // Create simulation
      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(30));

      // Zoom behavior
      const g = svg.append('g');

      svg.call(d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        }));

      // Draw links
      const link = g.append('g')
        .selectAll('line')
        .data(links)
        .enter()
        .append('line')
        .attr('class', d => 'link ' + (d.type || type))
        .attr('stroke-width', 1.5);

      // Draw nodes
      const node = g.append('g')
        .selectAll('.node')
        .data(data.nodes)
        .enter()
        .append('g')
        .attr('class', 'node')
        .call(d3.drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended));

      // Node circles
      node.append('circle')
        .attr('r', d => d.kind === 'class' ? 12 : d.kind === 'interface' ? 10 : 8)
        .attr('fill', d => {
          if (d.kind === 'class') return '#5a3d80';
          if (d.kind === 'interface') return '#3d8050';
          return '#3d5a80';
        });

      // Node labels
      node.append('text')
        .attr('dx', 15)
        .attr('dy', 4)
        .text(d => {
          const name = d.name;
          if (type === 'import') {
            // Show just filename for imports
            return name.split('/').pop();
          }
          return name;
        });

      // Tooltip
      const tooltip = d3.select('#tooltip');

      node.on('mouseover', (event, d) => {
        tooltip.style('display', 'block')
          .html(\`
            <div class="name">\${d.name}</div>
            <div class="kind">\${d.kind}</div>
            \${d.extendsName ? '<div class="location">extends ' + d.extendsName + '</div>' : ''}
          \`);
      })
      .on('mousemove', (event) => {
        tooltip.style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY - 10) + 'px');
      })
      .on('mouseout', () => {
        tooltip.style('display', 'none');
      })
      .on('click', async (event, d) => {
        if (type === 'hierarchy') {
          const def = definitions.find(def => def.id === d.id);
          if (def) {
            await selectDefinition(def);
          }
        } else {
          const file = files.find(f => f.id === d.id);
          if (file) {
            await selectFile(file);
          }
        }
      });

      // Update positions on tick
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

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

    function highlightFileInGraph(fileId) {
      d3.selectAll('.node circle').attr('stroke', d => d.id === fileId ? '#fff' : '#3c3c3c');
    }

    function highlightClassInGraph(defId) {
      d3.selectAll('.node circle').attr('stroke', d => d.id === defId ? '#fff' : '#3c3c3c');
    }

    // Utilities
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // Start
    init();
  </script>
</body>
</html>`;
}
