export const currentRssBytes = (): number => {
  return process.memoryUsage().rss;
};

export const createRssTracker = (): { sample: () => void; peakBytes: () => number } => {
  let peak = currentRssBytes();

  return {
    sample() {
      peak = Math.max(peak, currentRssBytes());
    },
    peakBytes() {
      return peak;
    },
  };
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${units[unitIndex] ?? 'KB'}`;
};
