import { type Calculator, type Operation, PI, add, subtract } from './utils';

export function calculate(op: Operation, a: number, b: number): number {
  if (op === 'add') {
    return add(a, b);
  }
  return subtract(a, b);
}

export class BasicCalculator implements Calculator {
  add(a: number, b: number): number {
    return add(a, b);
  }

  subtract(a: number, b: number): number {
    return subtract(a, b);
  }
}

console.log(`PI is approximately ${PI}`);
