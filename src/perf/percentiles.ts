export const percentile = (values: number[], percentileRank: number): number => {
  if (values.length === 0) {
    return 0;
  }

  if (percentileRank <= 0) {
    return values[0] ?? 0;
  }

  if (percentileRank >= 100) {
    return values[values.length - 1] ?? 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
};

export const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
};
