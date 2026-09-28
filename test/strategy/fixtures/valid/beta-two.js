import { Strategy, hold } from '../../../../src/strategy/base-strategy.js';

export default class BetaTwo extends Strategy {
  static id = 'beta-two';
  get warmup() { return 1; }
  onCandle() { return hold('IDLE', 'nunca opera'); }
}
