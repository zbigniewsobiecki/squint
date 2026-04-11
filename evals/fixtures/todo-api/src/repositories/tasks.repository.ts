import type { Task } from '../types.js';
import { BaseRepository } from './base.repository.js';

export class TasksRepository extends BaseRepository<Task> {
  findByOwner(ownerId: string): Task[] {
    return this.findAll().filter((t) => t.ownerId === ownerId);
  }

  findCompleted(ownerId: string): Task[] {
    return this.findByOwner(ownerId).filter((t) => t.completed);
  }
}

export const tasksRepository = new TasksRepository();
