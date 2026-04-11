import { eventBus } from '../events/event-bus.js';
import { tasksRepository } from '../repositories/tasks.repository.js';
import type { NewTaskInput, Task } from '../types.js';

export class TasksService {
  list(ownerId: string): Task[] {
    return tasksRepository.findByOwner(ownerId);
  }

  get(id: string): Task | null {
    return tasksRepository.findById(id);
  }

  create(ownerId: string, input: NewTaskInput): Task {
    const task: Task = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      description: input.description,
      ownerId,
      completed: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    tasksRepository.save(task);
    eventBus.emit('task.created', { taskId: task.id, ownerId });
    return task;
  }

  update(id: string, patch: Partial<Pick<Task, 'title' | 'description'>>): Task | null {
    const task = tasksRepository.findById(id);
    if (!task) return null;
    const next: Task = { ...task, ...patch };
    tasksRepository.save(next);
    return next;
  }

  complete(id: string): Task | null {
    const task = tasksRepository.findById(id);
    if (!task) return null;
    const next: Task = { ...task, completed: true, completedAt: new Date().toISOString() };
    tasksRepository.save(next);
    eventBus.emit('task.completed', { taskId: next.id, ownerId: next.ownerId });
    return next;
  }

  delete(id: string): boolean {
    return tasksRepository.delete(id);
  }
}

export const tasksService = new TasksService();
