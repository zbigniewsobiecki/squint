// Generic abstract repository. Exercises the BaseRepository<T> sharp edge:
// squint's extends_name extraction must produce 'BaseRepository' (not
// 'BaseRepository<Task>') for subclasses.

export abstract class BaseRepository<T extends { id: string }> {
  protected items = new Map<string, T>();

  findAll(): T[] {
    return Array.from(this.items.values());
  }

  findById(id: string): T | null {
    return this.items.get(id) ?? null;
  }

  save(item: T): T {
    this.items.set(item.id, item);
    return item;
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }
}
