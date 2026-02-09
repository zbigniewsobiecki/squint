import * as d3 from 'd3';
import type { Interaction } from '../types/api';
import { getBoxColors } from './module-dag';

export interface ChordModule {
  id: number;
  name: string;
  fullPath: string;
}

interface ChordData {
  modules: ChordModule[];
  matrix: number[][];
  interactionsByKey: Map<string, Interaction[]>;
}

export interface ChordSelection {
  kind: 'module';
  moduleIndex: number;
  module: ChordModule;
  interactions: Interaction[];
}

export interface ChordRibbonSelection {
  kind: 'ribbon';
  from: ChordModule;
  to: ChordModule;
  interactions: Interaction[];
}

export type ChordSelectEvent = ChordSelection | ChordRibbonSelection | null;

function stripPrefix(path: string): string {
  return path.replace(/^project\./, '');
}

export function buildChordData(interactions: Interaction[]): ChordData {
  // Collect unique modules
  const moduleMap = new Map<number, ChordModule>();
  for (const ix of interactions) {
    // Filter self-loops
    if (ix.fromModuleId === ix.toModuleId) continue;
    if (ix.weight <= 0) continue;

    if (!moduleMap.has(ix.fromModuleId)) {
      moduleMap.set(ix.fromModuleId, {
        id: ix.fromModuleId,
        name: stripPrefix(ix.fromModulePath),
        fullPath: ix.fromModulePath,
      });
    }
    if (!moduleMap.has(ix.toModuleId)) {
      moduleMap.set(ix.toModuleId, {
        id: ix.toModuleId,
        name: stripPrefix(ix.toModulePath),
        fullPath: ix.toModulePath,
      });
    }
  }

  // Sort alphabetically by fullPath for stable index assignment
  const modules = [...moduleMap.values()].sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  const idxById = new Map<number, number>();
  for (let i = 0; i < modules.length; i++) {
    idxById.set(modules[i].id, i);
  }

  const n = modules.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const interactionsByKey = new Map<string, Interaction[]>();

  for (const ix of interactions) {
    if (ix.fromModuleId === ix.toModuleId) continue;
    if (ix.weight <= 0) continue;

    const fromIdx = idxById.get(ix.fromModuleId);
    const toIdx = idxById.get(ix.toModuleId);
    if (fromIdx === undefined || toIdx === undefined) continue;

    matrix[fromIdx][toIdx] += ix.weight;

    const key = `${fromIdx}->${toIdx}`;
    if (!interactionsByKey.has(key)) {
      interactionsByKey.set(key, []);
    }
    interactionsByKey.get(key)!.push(ix);

    if (ix.direction === 'bi') {
      matrix[toIdx][fromIdx] += ix.weight;

      const reverseKey = `${toIdx}->${fromIdx}`;
      if (!interactionsByKey.has(reverseKey)) {
        interactionsByKey.set(reverseKey, []);
      }
      interactionsByKey.get(reverseKey)!.push(ix);
    }
  }

  return { modules, matrix, interactionsByKey };
}

// Use the same branch color system as the modules view
function moduleColor(colorIndex: number): string {
  return getBoxColors(1, colorIndex).stroke;
}

function moduleColorDim(colorIndex: number): string {
  return getBoxColors(1, colorIndex).fill;
}

export function renderChordDiagram(
  svgSelector: string,
  containerSelector: string,
  interactions: Interaction[],
  onSelect?: (event: ChordSelectEvent) => void,
  colorIndexByModuleId?: Map<number, number>
): void {
  const mainContainer = document.querySelector(containerSelector);
  if (!mainContainer) return;

  const svgEl = document.querySelector(svgSelector) as SVGSVGElement;
  if (!svgEl) return;
  const width = svgEl.clientWidth;
  const height = svgEl.clientHeight;
  if (width === 0 || height === 0) return;

  const { modules, matrix, interactionsByKey } = buildChordData(interactions);
  if (modules.length === 0) return;

  // Resolve color index: prefer data-driven colorIndex, fall back to positional index
  function resolveColorIndex(positionalIdx: number): number {
    if (!colorIndexByModuleId) return positionalIdx;
    const mod = modules[positionalIdx];
    return colorIndexByModuleId.get(mod.id) ?? positionalIdx;
  }

  const svg = d3.select<SVGSVGElement, unknown>(svgSelector);
  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const outerRadius = Math.min(width, height) / 2 - 80;
  const innerRadius = outerRadius - 20;

  const g = svg.append('g').attr('transform', `translate(${width / 2},${height / 2})`);

  const tooltip = d3.select('#tooltip');

  // Build chord layout
  const chordLayout = d3.chordDirected().padAngle(0.04).sortSubgroups(d3.descending);

  const chords = chordLayout(matrix);

  const arc = d3.arc<d3.ChordGroup>().innerRadius(innerRadius).outerRadius(outerRadius);

  const ribbon = d3
    .ribbonArrow<d3.Chord, d3.ChordSubgroup>()
    .radius(innerRadius)
    .headRadius(innerRadius * 0.05);

  // Helper: get pattern for a ribbon
  function ribbonPattern(d: d3.Chord): string | null {
    const key = `${d.source.index}->${d.target.index}`;
    const ixs = interactionsByKey.get(key);
    if (!ixs || ixs.length === 0) return null;
    return ixs[0].pattern;
  }

  // Collect all interactions for a module index (both directions)
  function interactionsForModule(idx: number): Interaction[] {
    const seen = new Set<number>();
    const result: Interaction[] = [];
    for (const [key, ixs] of interactionsByKey) {
      const [fromStr, toStr] = key.split('->');
      if (Number(fromStr) === idx || Number(toStr) === idx) {
        for (const ix of ixs) {
          if (!seen.has(ix.id)) {
            seen.add(ix.id);
            result.push(ix);
          }
        }
      }
    }
    return result;
  }

  // Track active selection for sticky highlight
  let activeSelection: { kind: 'module'; index: number } | { kind: 'ribbon'; source: number; target: number } | null =
    null;

  function applyHighlight(kind: 'module' | 'ribbon', idx: number, targetIdx?: number) {
    if (kind === 'module') {
      ribbons.style('fill-opacity', (rd) => {
        return rd.source.index === idx || rd.target.index === idx ? 0.7 : 0.05;
      });
      arcs.style('opacity', (ad) => {
        if (ad.index === idx) return 1;
        const connected = chords.some(
          (c) =>
            (c.source.index === idx && c.target.index === ad.index) ||
            (c.target.index === idx && c.source.index === ad.index)
        );
        return connected ? 1 : 0.3;
      });
    } else if (kind === 'ribbon' && targetIdx !== undefined) {
      ribbons.style('fill-opacity', (rd) => {
        return rd.source.index === idx && rd.target.index === targetIdx ? 0.8 : 0.05;
      });
      arcs.style('opacity', (ad) => {
        return ad.index === idx || ad.index === targetIdx ? 1 : 0.3;
      });
    }
  }

  function clearHighlight() {
    ribbons.style('fill-opacity', null);
    arcs.style('opacity', null);
  }

  // Draw ribbons
  const ribbons = g
    .append('g')
    .attr('class', 'chord-ribbons')
    .selectAll<SVGPathElement, d3.Chord>('path')
    .data(chords)
    .join('path')
    .attr('class', (d) => {
      const pattern = ribbonPattern(d);
      return pattern === 'business' ? 'chord-ribbon chord-ribbon-business' : 'chord-ribbon chord-ribbon-utility';
    })
    .attr('d', (d) => ribbon(d) as unknown as string)
    .attr('fill', (d) => moduleColorDim(resolveColorIndex(d.source.index)))
    .attr('stroke', (d) => {
      const pattern = ribbonPattern(d);
      return pattern === 'utility' ? moduleColor(resolveColorIndex(d.source.index)) : 'none';
    })
    .attr('stroke-width', (d) => {
      const pattern = ribbonPattern(d);
      return pattern === 'utility' ? 0.8 : 0;
    });

  // Ribbon hover + click
  ribbons
    .on('mouseover', (_event, d) => {
      if (activeSelection) return;
      applyHighlight('ribbon', d.source.index, d.target.index);

      const fromMod = modules[d.source.index];
      const toMod = modules[d.target.index];
      const key = `${d.source.index}->${d.target.index}`;
      const ixs = interactionsByKey.get(key) ?? [];
      const totalWeight = ixs.reduce((sum, ix) => sum + ix.weight, 0);
      const pattern = ixs[0]?.pattern ?? 'unknown';
      const semantic = ixs[0]?.semantic ?? '';

      tooltip.style('display', 'block').html(`
        <div class="name">${fromMod.name} → ${toMod.name}</div>
        <div class="location">${fromMod.fullPath} → ${toMod.fullPath}</div>
        <span class="kind">${pattern}</span>
        <span class="lines">weight: ${totalWeight}</span>
        ${semantic ? `<div class="location" style="margin-top: 4px; font-style: italic;">${semantic}</div>` : ''}
      `);
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
      if (!activeSelection) clearHighlight();
    })
    .on('click', (_event, d) => {
      const key = `${d.source.index}->${d.target.index}`;
      const ixs = interactionsByKey.get(key) ?? [];
      activeSelection = { kind: 'ribbon', source: d.source.index, target: d.target.index };
      applyHighlight('ribbon', d.source.index, d.target.index);
      onSelect?.({
        kind: 'ribbon',
        from: modules[d.source.index],
        to: modules[d.target.index],
        interactions: ixs,
      });
    });

  // Draw arcs
  const arcs = g
    .append('g')
    .attr('class', 'chord-arcs')
    .selectAll<SVGGElement, d3.ChordGroup>('g')
    .data(chords.groups)
    .join('g')
    .attr('class', 'chord-arc');

  arcs
    .append('path')
    .attr('d', (d) => arc(d))
    .attr('fill', (_d, i) => moduleColor(resolveColorIndex(i)))
    .attr('stroke', (_d, i) => moduleColor(resolveColorIndex(i)));

  // Arc hover + click
  arcs
    .on('mouseover', (_event, d) => {
      if (activeSelection) return;
      const idx = d.index;
      applyHighlight('module', idx);

      const mod = modules[idx];
      let outgoing = 0;
      let incoming = 0;
      for (let j = 0; j < modules.length; j++) {
        outgoing += matrix[idx][j];
        incoming += matrix[j][idx];
      }

      tooltip.style('display', 'block').html(`
        <div class="name">${mod.name}</div>
        <div class="location">${mod.fullPath}</div>
        <span class="kind">outgoing: ${outgoing}</span>
        <span class="lines">incoming: ${incoming}</span>
      `);
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
      if (!activeSelection) clearHighlight();
    })
    .on('click', (_event, d) => {
      const idx = d.index;
      activeSelection = { kind: 'module', index: idx };
      applyHighlight('module', idx);
      onSelect?.({
        kind: 'module',
        moduleIndex: idx,
        module: modules[idx],
        interactions: interactionsForModule(idx),
      });
    });

  // Background click to deselect
  svg.on('click', (event) => {
    if (event.target === svgEl) {
      activeSelection = null;
      clearHighlight();
      onSelect?.(null);
    }
  });

  // Labels
  g.append('g')
    .attr('class', 'chord-labels')
    .selectAll<SVGTextElement, d3.ChordGroup>('text')
    .data(chords.groups)
    .join('text')
    .attr('class', 'chord-label')
    .each(function (d) {
      const angle = (d.startAngle + d.endAngle) / 2;
      const flip = angle > Math.PI;
      const labelRadius = outerRadius + 8;
      d3.select(this)
        .attr(
          'transform',
          `rotate(${(angle * 180) / Math.PI - 90}) translate(${labelRadius},0)${flip ? ' rotate(180)' : ''}`
        )
        .attr('text-anchor', flip ? 'end' : 'start')
        .attr('dominant-baseline', 'central');
    })
    .text((_d, i) => modules[i].name);
}
