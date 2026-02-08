import type { ApiClient } from '../api/client';
import type { Store } from '../state/store';
import type { Module } from '../types/api';

interface ModuleTreeNode extends Module {
  children: ModuleTreeNode[];
}

export function initModulesTree(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.modulesData;

  if (!data || data.modules.length === 0) {
    showEmptyState();
    return;
  }

  renderModulesView(store);
}

function showEmptyState() {
  const container = document.getElementById('graph-container');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No modules found</h2>
        <p>Run 'ats llm modules' to detect modules</p>
      </div>
    `;
  }
}

function renderModulesView(store: Store) {
  const state = store.getState();
  const modulesData = state.modulesData;
  if (!modulesData) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  // Build tree structure from flat modules using parentId
  const moduleMap = new Map<number, ModuleTreeNode>();
  for (const m of modulesData.modules) {
    moduleMap.set(m.id, { ...m, children: [] });
  }

  const roots: ModuleTreeNode[] = [];
  for (const m of moduleMap.values()) {
    if (m.parentId === null) {
      roots.push(m);
    } else {
      const parent = moduleMap.get(m.parentId);
      if (parent) {
        parent.children.push(m);
      } else {
        roots.push(m);
      }
    }
  }

  // Sort children by name at each level
  function sortChildren(node: ModuleTreeNode) {
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
  function renderTreeNode(module: ModuleTreeNode, depth = 0): string {
    const hasChildren = module.children.length > 0;
    const depthClass = `depth-${Math.min(depth, 5)}`;
    const isRoot = depth === 0;

    const membersHtml = module.members
      .map(
        (m) => `
        <div class="module-member">
          <span class="module-member-kind kind-${m.kind}">${m.kind}</span>
          <span class="module-member-name">${m.name}</span>
          <span class="module-member-file">${m.filePath.split('/').slice(-1)[0]}:${m.line}</span>
        </div>
      `
      )
      .join('');

    const childrenHtml = module.children.map((child) => renderTreeNode(child, depth + 1)).join('');

    return `
      <div class="module-node ${depthClass}${isRoot && hasChildren ? ' expanded' : ''}" data-module-id="${module.id}">
        <div class="module-node-header">
          <span class="module-toggle ${hasChildren ? 'has-children' : ''}">
            ${hasChildren ? '▶' : '○'}
          </span>
          <span class="module-node-name">${module.name}</span>
          <span class="module-node-path">${module.fullPath}</span>
          <span class="module-node-badge">${module.memberCount}</span>
        </div>
        <div class="module-details">
          ${module.description ? `<div class="module-description">${module.description}</div>` : ''}
          ${
            module.members.length > 0
              ? `
              <div class="module-members-header">
                Members (${module.memberCount})
              </div>
              <div class="module-members-list">${membersHtml}</div>
            `
              : '<div class="module-members-header">No direct members</div>'
          }
        </div>
        ${hasChildren ? `<div class="module-children">${childrenHtml}</div>` : ''}
      </div>
    `;
  }

  const treeHtml = roots.map((root) => renderTreeNode(root, 0)).join('');

  container.innerHTML = `
    <div class="module-tree">
      <h2>
        Module Tree
        <span class="view-stats">${modulesData.stats.moduleCount} modules, ${modulesData.stats.assigned} symbols assigned</span>
      </h2>
      <div class="tree-container">${treeHtml}</div>
    </div>
  `;

  // Add event listeners for tree interactions
  container.querySelectorAll('.module-node-header').forEach((header) => {
    header.addEventListener('click', () => {
      const node = header.closest('.module-node');
      const toggle = header.querySelector('.module-toggle');
      const hasChildren = toggle?.classList.contains('has-children');

      if (hasChildren && node) {
        node.classList.toggle('expanded');
      }
      node?.classList.toggle('show-details');
    });
  });
}
