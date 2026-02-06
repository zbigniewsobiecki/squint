import type { User, UserId } from './types';

export default class UserService {
  private users: Map<UserId, User> = new Map();

  getUser(id: UserId): User | undefined {
    return this.users.get(id);
  }

  createUser(user: User): void {
    this.users.set(user.id, user);
  }

  deleteUser(id: UserId): boolean {
    return this.users.delete(id);
  }
}

export function createUserService(): UserService {
  return new UserService();
}
