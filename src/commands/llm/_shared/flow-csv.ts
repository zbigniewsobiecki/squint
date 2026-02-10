/**
 * CSV parser for LLM-generated flow output.
 *
 * Handles two output formats:
 * 1. Entry point classification (Phase 1)
 * 2. Flow construction with sub-flow references (Phase 2)
 */

import { extractCsvContent, parseCsvWithMapper, parseRow, safeParseInt, splitCsvLines } from './csv-utils.js';

// ============================================
// Entry Point Classification (Phase 1)
// ============================================

export type EntryPointClassification = 'top_level' | 'subflow_candidate' | 'internal';

export interface ClassifiedEntryPoint {
  id: number;
  classification: EntryPointClassification;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface EntryPointParseResult {
  entries: ClassifiedEntryPoint[];
  errors: string[];
}

/**
 * Parse entry point classification output.
 * Expected format: type,id,classification,confidence,reason
 */
export function parseEntryPointClassification(content: string): EntryPointParseResult {
  const { items, errors } = parseCsvWithMapper<ClassifiedEntryPoint>(content, {
    minColumns: 5,
    rowMapper: (cols, lineNum, errs) => {
      const [type, idStr, classification, confidence, reason] = cols;

      if (type !== 'entry') return null; // Skip non-entry rows

      const id = safeParseInt(idStr, 'ID', lineNum, errs);
      if (id === null) return null;

      if (!isValidClassification(classification)) {
        errs.push(`Line ${lineNum}: Invalid classification "${classification}"`);
        return null;
      }
      if (!isValidConfidence(confidence)) {
        errs.push(`Line ${lineNum}: Invalid confidence "${confidence}"`);
        return null;
      }

      return { id, classification, confidence, reason };
    },
  });

  return { entries: items, errors };
}

function isValidClassification(s: string): s is EntryPointClassification {
  return s === 'top_level' || s === 'subflow_candidate' || s === 'internal';
}

function isValidConfidence(s: string): s is 'high' | 'medium' | 'low' {
  return s === 'high' || s === 'medium' || s === 'low';
}

// ============================================
// Flow Construction (Phase 2)
// ============================================

export interface ParsedFlowStep {
  type: 'definition' | 'subflow';
  order: number;
  id?: number; // Definition ID for 'definition' type
  flowName?: string; // Flow name for 'subflow' type
}

export interface ParsedFlow {
  id: number;
  name: string;
  description: string;
  domain: string | null;
  isComposite: boolean;
  steps: ParsedFlowStep[];
  subflowReasons: Map<number, string>; // stepOrder -> reason
}

export interface FlowParseResult {
  flows: ParsedFlow[];
  errors: string[];
}

/**
 * Parse flow construction output.
 * Expected format:
 * ```csv
 * type,flow_id,field,value
 * flow,1,name,"UserRegistration"
 * flow,1,description,"Handles new user signup"
 * flow,1,domain,"auth"
 * flow,1,is_composite,"true"
 * step,1,1,42
 * step,1,2,subflow:ValidateUser
 * step,1,3,89
 * subflow_reason,1,2,"Delegates input validation to reusable validation flow"
 * ```
 */
export function parseFlowConstruction(content: string): FlowParseResult {
  const errors: string[] = [];
  const flowsMap = new Map<number, ParsedFlow>();

  const csv = extractCsvContent(content);
  const lines = splitCsvLines(csv);

  if (lines.length === 0) {
    errors.push('Empty CSV content');
    return { flows: [], errors };
  }

  // Validate header
  const header = parseRow(lines[0]);
  if (!header || header.length < 4) {
    errors.push(`Invalid header: expected "type,flow_id,field,value", got "${lines[0]}"`);
    return { flows: [], errors };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parsed = parseRow(line);
    if (!parsed || parsed.length < 4) {
      errors.push(`Line ${i + 1}: Invalid row format`);
      continue;
    }

    const [type, flowIdStr, field, value] = parsed;
    const flowId = safeParseInt(flowIdStr, 'flow_id', i + 1, errors);
    if (flowId === null) continue;

    // Ensure flow exists in map
    if (!flowsMap.has(flowId)) {
      flowsMap.set(flowId, {
        id: flowId,
        name: '',
        description: '',
        domain: null,
        isComposite: false,
        steps: [],
        subflowReasons: new Map(),
      });
    }
    const flow = flowsMap.get(flowId)!;

    switch (type) {
      case 'flow':
        switch (field) {
          case 'name':
            flow.name = value.trim();
            break;
          case 'description':
            flow.description = value.trim();
            break;
          case 'domain':
            flow.domain = value.trim() || null;
            break;
          case 'is_composite':
            flow.isComposite = value.trim().toLowerCase() === 'true';
            break;
          default:
            errors.push(`Line ${i + 1}: Unknown flow field "${field}"`);
        }
        break;

      case 'step': {
        const stepOrder = safeParseInt(field, 'step order', i + 1, errors);
        if (stepOrder === null) continue;

        const stepValue = value.trim();
        if (stepValue.startsWith('subflow:')) {
          const flowName = stepValue.slice(8).trim();
          flow.steps.push({
            type: 'subflow',
            order: stepOrder,
            flowName,
          });
          flow.isComposite = true;
        } else {
          const defId = safeParseInt(stepValue, 'step definition ID', i + 1, errors);
          if (defId === null) continue;
          flow.steps.push({
            type: 'definition',
            order: stepOrder,
            id: defId,
          });
        }
        break;
      }

      case 'subflow_reason': {
        const stepOrder = safeParseInt(field, 'step order for subflow_reason', i + 1, errors);
        if (stepOrder === null) continue;
        flow.subflowReasons.set(stepOrder, value.trim());
        break;
      }

      default:
        errors.push(`Line ${i + 1}: Unknown row type "${type}"`);
    }
  }

  // Sort steps by order for each flow
  for (const flow of flowsMap.values()) {
    flow.steps.sort((a, b) => a.order - b.order);
  }

  return {
    flows: Array.from(flowsMap.values()).filter((f) => f.name !== ''),
    errors,
  };
}

// ============================================
// Gap Filling (Phase 3)
// ============================================

export interface GapFillSuggestion {
  type: 'new_flow' | 'add_to_existing' | 'new_subflow';
  symbolId: number;
  targetFlowId?: number; // For 'add_to_existing'
  reason: string;
}

export interface GapFillParseResult {
  suggestions: GapFillSuggestion[];
  errors: string[];
}

/**
 * Parse gap filling suggestions.
 * Expected format: type,symbol_id,target_flow_id,reason
 */
export function parseGapFillSuggestions(content: string): GapFillParseResult {
  const { items, errors } = parseCsvWithMapper<GapFillSuggestion>(content, {
    minColumns: 4,
    rowMapper: (cols, lineNum, errs) => {
      const [type, symbolIdStr, targetFlowIdStr, reason] = cols;

      if (!isValidGapFillType(type)) {
        errs.push(`Line ${lineNum}: Invalid suggestion type "${type}"`);
        return null;
      }

      const symbolId = safeParseInt(symbolIdStr, 'symbol_id', lineNum, errs);
      if (symbolId === null) return null;

      const targetFlowId = targetFlowIdStr ? Number.parseInt(targetFlowIdStr, 10) : undefined;
      if (type === 'add_to_existing' && (targetFlowId === undefined || Number.isNaN(targetFlowId))) {
        errs.push(`Line ${lineNum}: add_to_existing requires valid target_flow_id`);
        return null;
      }

      return {
        type,
        symbolId,
        targetFlowId: targetFlowId && !Number.isNaN(targetFlowId) ? targetFlowId : undefined,
        reason,
      };
    },
  });

  return { suggestions: items, errors };
}

function isValidGapFillType(s: string): s is GapFillSuggestion['type'] {
  return s === 'new_flow' || s === 'add_to_existing' || s === 'new_subflow';
}
