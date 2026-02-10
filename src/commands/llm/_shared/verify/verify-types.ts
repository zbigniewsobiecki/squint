export type VerifySeverity = 'error' | 'warning' | 'info';

export interface VerificationIssue {
  definitionId?: number;
  definitionName?: string;
  filePath?: string;
  line?: number;
  severity: VerifySeverity;
  category: string;
  message: string;
  suggestion?: string;
  fixData?: {
    action: 'set-pure-false' | 'change-relationship-type' | 'move-to-test-module' | 'remove-flow';
    targetDefinitionId?: number;
    expectedType?: string;
  };
}

export interface CoverageCheckResult {
  passed: boolean;
  issues: VerificationIssue[];
  stats: {
    totalDefinitions: number;
    annotatedDefinitions: number;
    totalRelationships: number;
    annotatedRelationships: number;
    missingCount: number;
    structuralIssueCount: number;
  };
}

export interface ContentVerificationResult {
  issues: VerificationIssue[];
  stats: {
    checked: number;
    issuesFound: number;
    batchesProcessed: number;
  };
}

export interface VerifyReport {
  phase1: CoverageCheckResult;
  phase2?: ContentVerificationResult;
}
