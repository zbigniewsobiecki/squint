import type {
  ContractsResponse,
  DbStats,
  FlowsDagResponse,
  FlowsResponse,
  InteractionsResponse,
  ModulesResponse,
  SymbolGraphResponse,
} from '../types/api';

// API client interface
export interface ApiClient {
  getStats(): Promise<DbStats>;
  getSymbolGraph(): Promise<SymbolGraphResponse>;
  getModules(): Promise<ModulesResponse>;
  getFlows(): Promise<FlowsResponse>;
  getFlowsDag(): Promise<FlowsDagResponse>;
  getInteractions(): Promise<InteractionsResponse>;
  getContracts(): Promise<ContractsResponse>;
}

// Create the API client
export function createApiClient(baseUrl = ''): ApiClient {
  async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`);

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  return {
    getStats() {
      return fetchJson<DbStats>('/api/stats');
    },

    getSymbolGraph() {
      return fetchJson<SymbolGraphResponse>('/api/graph/symbols');
    },

    getModules() {
      return fetchJson<ModulesResponse>('/api/modules');
    },

    getFlows() {
      return fetchJson<FlowsResponse>('/api/flows');
    },

    getFlowsDag() {
      return fetchJson<FlowsDagResponse>('/api/flows/dag');
    },

    getInteractions() {
      return fetchJson<InteractionsResponse>('/api/interactions');
    },

    getContracts() {
      return fetchJson<ContractsResponse>('/api/contracts');
    },
  };
}
