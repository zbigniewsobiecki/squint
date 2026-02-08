import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStore, toggleFlow, toggleModule, selectAllFlows, clearFlowSelection } from './store';
import type { Store } from './store';

describe('store', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  describe('createStore', () => {
    it('returns initial state with default values', () => {
      const state = store.getState();

      expect(state.graphData).toBeNull();
      expect(state.modulesData).toBeNull();
      expect(state.flowsData).toBeNull();
      expect(state.flowsDagData).toBeNull();
      expect(state.currentView).toBe('force');
      expect(state.selectedGrouping).toBe('structure');
      expect(state.selectedFlows).toBeInstanceOf(Set);
      expect(state.selectedFlows.size).toBe(0);
      expect(state.expandedModules).toBeInstanceOf(Set);
      expect(state.expandedModules.size).toBe(0);
      expect(state.sidebarCollapsed).toBe(false);
      expect(state.loading).toBe(true);
      expect(state.error).toBeNull();
    });
  });

  describe('setState', () => {
    it('updates state with partial values', () => {
      store.setState({ loading: false, currentView: 'modules' });

      const state = store.getState();
      expect(state.loading).toBe(false);
      expect(state.currentView).toBe('modules');
      // Other values unchanged
      expect(state.error).toBeNull();
    });

    it('notifies subscribers on state change', () => {
      const callback = vi.fn();
      store.subscribe(callback);

      store.setState({ loading: false });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(store.getState());
    });

    it('notifies multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      store.subscribe(callback1);
      store.subscribe(callback2);

      store.setState({ error: 'test error' });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    it('returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = store.subscribe(callback);

      store.setState({ loading: false });
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      store.setState({ loading: true });
      // Still only called once, not after unsubscribe
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('allows multiple subscriptions and unsubscriptions', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const unsub1 = store.subscribe(callback1);
      const unsub2 = store.subscribe(callback2);

      store.setState({ loading: false });
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      unsub1();
      store.setState({ loading: true });
      expect(callback1).toHaveBeenCalledTimes(1); // Not called again
      expect(callback2).toHaveBeenCalledTimes(2); // Called again

      unsub2();
      store.setState({ error: 'test' });
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(2);
    });
  });

  describe('toggleFlow', () => {
    it('adds flow id to selectedFlows when not present', () => {
      toggleFlow(store, 1);

      const state = store.getState();
      expect(state.selectedFlows.has(1)).toBe(true);
    });

    it('removes flow id from selectedFlows when present', () => {
      store.setState({ selectedFlows: new Set([1, 2, 3]) });

      toggleFlow(store, 2);

      const state = store.getState();
      expect(state.selectedFlows.has(1)).toBe(true);
      expect(state.selectedFlows.has(2)).toBe(false);
      expect(state.selectedFlows.has(3)).toBe(true);
    });

    it('toggles same flow id multiple times', () => {
      toggleFlow(store, 5);
      expect(store.getState().selectedFlows.has(5)).toBe(true);

      toggleFlow(store, 5);
      expect(store.getState().selectedFlows.has(5)).toBe(false);

      toggleFlow(store, 5);
      expect(store.getState().selectedFlows.has(5)).toBe(true);
    });
  });

  describe('toggleModule', () => {
    it('adds module id to expandedModules when not present', () => {
      toggleModule(store, 10);

      const state = store.getState();
      expect(state.expandedModules.has(10)).toBe(true);
    });

    it('removes module id from expandedModules when present', () => {
      store.setState({ expandedModules: new Set([10, 20, 30]) });

      toggleModule(store, 20);

      const state = store.getState();
      expect(state.expandedModules.has(10)).toBe(true);
      expect(state.expandedModules.has(20)).toBe(false);
      expect(state.expandedModules.has(30)).toBe(true);
    });
  });

  describe('selectAllFlows', () => {
    it('does nothing when flowsDagData is null', () => {
      selectAllFlows(store);

      const state = store.getState();
      expect(state.selectedFlows.size).toBe(0);
    });

    it('selects all flow ids from flowsDagData', () => {
      store.setState({
        flowsDagData: {
          modules: [],
          edges: [],
          flows: [
            { id: 1, name: 'Flow 1', stakeholder: null, stepCount: 2, steps: [] },
            { id: 2, name: 'Flow 2', stakeholder: null, stepCount: 3, steps: [] },
            { id: 3, name: 'Flow 3', stakeholder: null, stepCount: 1, steps: [] },
          ],
        },
      });

      selectAllFlows(store);

      const state = store.getState();
      expect(state.selectedFlows.size).toBe(3);
      expect(state.selectedFlows.has(1)).toBe(true);
      expect(state.selectedFlows.has(2)).toBe(true);
      expect(state.selectedFlows.has(3)).toBe(true);
    });
  });

  describe('clearFlowSelection', () => {
    it('clears all selected flows', () => {
      store.setState({ selectedFlows: new Set([1, 2, 3, 4, 5]) });

      clearFlowSelection(store);

      const state = store.getState();
      expect(state.selectedFlows.size).toBe(0);
    });

    it('works when no flows are selected', () => {
      clearFlowSelection(store);

      const state = store.getState();
      expect(state.selectedFlows.size).toBe(0);
    });
  });
});
