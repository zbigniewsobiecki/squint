import type { ApiClient } from '../api/client';
import { renderModuleDag } from '../d3/module-dag';
import type { Store } from '../state/store';
import type { Module } from '../types/api';

export function initModulesTree(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.flowsDagData;

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
  const flowsDagData = state.flowsDagData;
  if (!flowsDagData) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  // Build lookup from modulesData for descriptions and members
  const modulesData = state.modulesData;
  const moduleDetailById = new Map<number, Module>();
  if (modulesData) {
    for (const m of modulesData.modules) {
      moduleDetailById.set(m.id, m);
    }
  }

  // Build parent→children map for collecting descendant members
  const childrenByParent = new Map<number, number[]>();
  for (const m of flowsDagData.modules) {
    if (m.parentId !== null) {
      const siblings = childrenByParent.get(m.parentId) ?? [];
      siblings.push(m.id);
      childrenByParent.set(m.parentId, siblings);
    }
  }

  function collectDescendantIds(moduleId: number): number[] {
    const ids = [moduleId];
    const children = childrenByParent.get(moduleId) ?? [];
    for (const childId of children) {
      ids.push(...collectDescendantIds(childId));
    }
    return ids;
  }

  // Find root module for default sidebar content
  const rootModule = flowsDagData.modules.find((m) => m.parentId === null) ?? flowsDagData.modules[0];

  container.innerHTML = `
    <div class="modules-dag-container" id="modules-dag-main">
      <svg id="modules-dag-svg"></svg>
      <div class="modules-sidebar hidden" id="modules-sidebar"></div>
      <div class="keyboard-hint">
        <kbd>Click</kbd> circle to zoom in &nbsp; <kbd>Click</kbd> background to zoom out
      </div>
    </div>
  `;

  function onModuleSelect(selectedId: number | null) {
    const sidebar = document.getElementById('modules-sidebar');
    if (!sidebar) return;

    // On background click, show root content instead of hiding
    const moduleId = selectedId ?? rootModule.id;

    const dagModule = flowsDagData!.modules.find((m) => m.id === moduleId);
    if (!dagModule) return;

    const detail = moduleDetailById.get(moduleId);
    const description = detail?.description ?? null;

    // Collect all members from this module and its descendants, grouped by submodule
    const descendantIds = collectDescendantIds(moduleId);
    let totalMembers = 0;

    let groupedHtml = '';
    for (const id of descendantIds) {
      const mod = moduleDetailById.get(id);
      if (!mod?.members?.length) continue;
      const sectionName = id === moduleId ? dagModule.name : mod.name;
      groupedHtml += `<div class="modules-sidebar-section">${escapeHtml(sectionName)}</div>`;
      for (const member of mod.members) {
        groupedHtml += `
          <div class="modules-sidebar-member">
            <span class="member-kind">${escapeHtml(member.kind)}</span>
            <span class="member-name">${escapeHtml(member.name)}</span>
          </div>`;
        totalMembers++;
      }
    }
    if (!groupedHtml) {
      groupedHtml = '<div class="modules-sidebar-empty">No symbols assigned</div>';
    }

    const descHtml = description ? `<div class="modules-sidebar-desc">${escapeHtml(description)}</div>` : '';

    sidebar.innerHTML = `
      <div class="modules-sidebar-header">
        <h3>${escapeHtml(dagModule.name)}</h3>
        <span class="modules-sidebar-path">${escapeHtml(dagModule.fullPath)}</span>
      </div>
      ${descHtml}
      <div class="modules-sidebar-members">
        <div class="modules-sidebar-members-title">${totalMembers} symbol${totalMembers !== 1 ? 's' : ''}</div>
        <div class="modules-sidebar-members-list">
          ${groupedHtml}
        </div>
      </div>
    `;
    sidebar.classList.remove('hidden');
  }

  renderModuleDag('#modules-dag-svg', '#modules-dag-main', flowsDagData.modules, onModuleSelect);

  // Show root module content in sidebar on initial load
  onModuleSelect(rootModule.id);
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
