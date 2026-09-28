import { Strategy, hold } from '../../../../src/strategy/base-strategy.js';

export default class Alpha extends Strategy {
  static id = 'alpha';
  get warmup() { return 1; }
  onCandle() { return hold('IDLE', 'nunca opera'); }
}
