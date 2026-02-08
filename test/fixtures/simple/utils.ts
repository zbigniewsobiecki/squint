export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export const PI = Math.PI;

export interface Calculator {
  add(a: number, b: number): number;
  subtract(a: number, b: number): number;
}

export type Operation = 'add' | 'subtract';
