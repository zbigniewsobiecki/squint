import UserService, { createUserService } from './user-service';
export type { User, Post, UserId, PostId } from './types';
export { UserService, createUserService };

const service = createUserService();

service.createUser({
  id: '1',
  name: 'Test User',
  email: 'test@example.com',
});

const user = service.getUser('1');
console.log(user?.name);
