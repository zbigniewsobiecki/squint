// Frontend HTTP client. Calls the backend through an injected http function.
// squint's contract matcher should pair these calls with the backend
// controllers under the same paths.

import type { NewTaskInput, Task } from '../src/types.js';

const BASE_URL = 'http://localhost:3000';

type HttpFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ json(): Promise<unknown> }>;

// Injected by the runtime — Node 18+ globalThis.fetch in production.
const http: HttpFn = ((globalThis as { fetch?: HttpFn }).fetch ??
  (() => {
    throw new Error('no http');
  })) as HttpFn;

async function request<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await http(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as T;
}

export async function login(email: string, password: string): Promise<{ token: string }> {
  return request<{ token: string }>('POST', '/api/auth/login', '', { email, password });
}

export async function register(email: string, password: string): Promise<{ token: string }> {
  return request<{ token: string }>('POST', '/api/auth/register', '', { email, password });
}

export async function listTasks(token: string): Promise<Task[]> {
  return request<Task[]>('GET', '/api/tasks', token);
}

export async function getTask(token: string, id: string): Promise<Task> {
  return request<Task>('GET', `/api/tasks/${id}`, token);
}

export async function createTask(token: string, input: NewTaskInput): Promise<Task> {
  return request<Task>('POST', '/api/tasks', token, input);
}

export async function updateTask(
  token: string,
  id: string,
  patch: Partial<Pick<Task, 'title' | 'description'>>
): Promise<Task> {
  return request<Task>('PUT', `/api/tasks/${id}`, token, patch);
}

export async function completeTask(token: string, id: string): Promise<Task> {
  return request<Task>('PATCH', `/api/tasks/${id}/complete`, token);
}

export async function deleteTask(token: string, id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>('DELETE', `/api/tasks/${id}`, token);
}
