export interface Task {
  id: string;
  title: string;
  description: string;
  ownerId: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export interface NewTaskInput {
  title: string;
  description: string;
}
