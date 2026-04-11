import type { User } from '../types.js';

// Minimal "JWT" — opaque token, not real crypto. Realistic enough for squint
// to see signing and verification call sites.

const usersByEmail = new Map<string, User>();

function hashPassword(password: string): string {
  return `hashed:${password}`;
}

function verifyPassword(password: string, hash: string): boolean {
  return hash === `hashed:${password}`;
}

function signToken(user: User): string {
  return `token:${user.id}`;
}

function decodeToken(token: string): { id: string; email: string } | null {
  if (!token.startsWith('token:')) return null;
  const id = token.slice('token:'.length);
  for (const u of usersByEmail.values()) {
    if (u.id === id) return { id: u.id, email: u.email };
  }
  return null;
}

export class AuthService {
  async register(email: string, password: string): Promise<{ token: string; user: User }> {
    if (usersByEmail.has(email)) {
      throw new Error('user already exists');
    }
    const user: User = {
      id: `u_${usersByEmail.size + 1}`,
      email,
      passwordHash: hashPassword(password),
    };
    usersByEmail.set(email, user);
    return { token: signToken(user), user };
  }

  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    const user = usersByEmail.get(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new Error('invalid credentials');
    }
    return { token: signToken(user), user };
  }

  verify(token: string): { id: string; email: string } | null {
    return decodeToken(token);
  }
}

export const authService = new AuthService();
