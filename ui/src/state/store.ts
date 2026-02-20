import type {
  ContractsResponse,
  FlowsDagResponse,
  FlowsResponse,
  InteractionsResponse,
  ModulesResponse,
  SymbolGraphResponse,
} from '../types/api';

// Application state interface
export interface AppState {
  // Data
  graphData: SymbolGraphResponse | null;
  modulesData: ModulesResponse | null;
  flowsData: FlowsResponse | null;
  flowsDagData: FlowsDagResponse | null;
  interactionsData: InteractionsResponse | null;
  contractsData: ContractsResponse | null;

  // UI state
  currentView: 'symbols' | 'modules' | 'flows' | 'interactions' | 'files' | 'contracts';
  selectedRelationshipType: string | null;
  selectedFlowId: number | null; // Currently viewed flow (for detail view)
  selectedFlows: Set<number>;
  expandedModules: Set<number>;
  sidebarCollapsed: boolean;
  selectedSymbolId: number | null;
  symbolSearchQuery: string;
  hiddenSymbolKinds: Set<string>;

  // Loading states
  loading: boolean;
  error: string | null;
}

// Subscriber callback type
type Subscriber = (state: AppState) => void;

// Simple reactive store
export interface Store {
  getState(): AppState;
  setState(partial: Partial<AppState>): void;
  subscribe(callback: Subscriber): () => void;
}

export function createStore(): Store {
  // Initial state
  let state: AppState = {
    graphData: null,
    modulesData: null,
    flowsData: null,
    flowsDagData: null,
    interactionsData: null,
    contractsData: null,
    currentView: 'symbols',
    selectedRelationshipType: null,
    selectedFlowId: null,
    selectedFlows: new Set(),
    expandedModules: new Set(),
    sidebarCollapsed: false,
    selectedSymbolId: null,
    symbolSearchQuery: '',
    hiddenSymbolKinds: new Set(),
    loading: true,
    error: null,
  };

  // Subscribers
  const subscribers = new Set<Subscriber>();

  // Notify all subscribers
  function notify() {
    for (const callback of subscribers) {
      callback(state);
    }
  }

  return {
    getState() {
      return state;
    },

    setState(partial: Partial<AppState>) {
      state = { ...state, ...partial };
      notify();
    },

    subscribe(callback: Subscriber) {
      subscribers.add(callback);
      // Return unsubscribe function
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}

// Helper functions for common state operations
export function toggleFlow(store: Store, flowId: number) {
  const state = store.getState();
  const selectedFlows = new Set(state.selectedFlows);

  if (selectedFlows.has(flowId)) {
    selectedFlows.delete(flowId);
  } else {
    selectedFlows.add(flowId);
  }

  store.setState({ selectedFlows });
}

export function toggleModule(store: Store, moduleId: number) {
  const state = store.getState();
  const expandedModules = new Set(state.expandedModules);

  if (expandedModules.has(moduleId)) {
    expandedModules.delete(moduleId);
  } else {
    expandedModules.add(moduleId);
  }

  store.setState({ expandedModules });
}

export function selectAllFlows(store: Store) {
  const state = store.getState();
  if (!state.flowsDagData) return;

  const selectedFlows = new Set(state.flowsDagData.flows.map((f) => f.id));
  store.setState({ selectedFlows });
}

export function clearFlowSelection(store: Store) {
  store.setState({ selectedFlows: new Set() });
}

export function selectFlow(store: Store, flowId: number | null) {
  const selectedFlows = flowId ? new Set([flowId]) : new Set<number>();
  store.setState({ selectedFlowId: flowId, selectedFlows });
}

export function selectSymbol(store: Store, id: number | null) {
  store.setState({ selectedSymbolId: id });
}

export function setSymbolSearch(store: Store, query: string) {
  store.setState({ symbolSearchQuery: query });
}

export function toggleSymbolKind(store: Store, kind: string) {
  const state = store.getState();
  const hiddenSymbolKinds = new Set(state.hiddenSymbolKinds);

  if (hiddenSymbolKinds.has(kind)) {
    hiddenSymbolKinds.delete(kind);
  } else {
    hiddenSymbolKinds.add(kind);
  }

  store.setState({ hiddenSymbolKinds });
}

export function setRelationshipFilter(store: Store, type: string | null) {
  store.setState({ selectedRelationshipType: type });
}
