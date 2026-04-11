// In-memory pub/sub. Exercises a SECOND contract protocol beyond HTTP:
// squint should detect 'task.created' and 'task.completed' as events
// with producer (TasksService) and consumer (auditLogger) roles.

export type EventName = 'task.created' | 'task.completed';

export type EventHandler = (payload: Record<string, unknown>) => void;

export class EventBus {
  private handlers = new Map<EventName, EventHandler[]>();

  subscribe(event: EventName, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: EventName, payload: Record<string, unknown>): void {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      handler(payload);
    }
  }
}

export const eventBus = new EventBus();

// Audit subscriber. Listens for completion events and logs them. This
// represents an admin/system stakeholder consuming the 'task.completed' event.
export function auditLogger(payload: Record<string, unknown>): void {
  // In a real app, this would write to an audit log table.
  void payload;
}

eventBus.subscribe('task.completed', auditLogger);
