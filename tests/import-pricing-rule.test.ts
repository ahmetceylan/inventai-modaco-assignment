import { describe, expect, it } from 'vitest';
import {
  applyImportPricingRule,
  applyV1PricingRule,
  UnsupportedPricingRuleError,
} from '../src/ingestion/import-pricing-rule.js';

describe('Import pricing rule v1', () => {
  it('accepts and normalizes a vendor price with round-half-up', () => {
    expect(applyV1PricingRule('10.005')?.toFixed(2)).toBe('10.01');
    expect(applyV1PricingRule('10.004')?.toFixed(2)).toBe('10.00');
  });

  it('preserves decimal precision beyond JavaScript safe integers', () => {
    expect(applyV1PricingRule('9007199254.995')?.toFixed(2)).toBe('9007199255.00');
  });

  it.each(['-0.01', 'not-a-price', '1e2', '', '10000000000.00'])(
    'rejects invalid vendor price %s',
    (value) => {
      expect(applyV1PricingRule(value)).toBeNull();
    },
  );

  it('selects v1 explicitly', () => {
    expect(applyImportPricingRule('v1', '25.50')?.toFixed(2)).toBe('25.50');
  });

  it('rejects an unsupported pricing-rule version', () => {
    expect(() => applyImportPricingRule('v2', '10.00')).toThrow(UnsupportedPricingRuleError);
  });
});
