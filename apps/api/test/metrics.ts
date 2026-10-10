import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type Histogram,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';

// The application's metrics, kept in memory and read on demand, for specs that
// check what a code path recorded. Start it before the first recording of the
// spec file: the instruments of src/observability/metrics.ts bind to the meter
// provider registered when they are first used, for the life of the module
// (each spec file has its own).

class OnDemandReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RecordedMetrics {
  /** The histogram's data points, cumulative since the start; none when never recorded. */
  histogram(name: string): Promise<DataPoint<Histogram>[]>;
  /** Back to the no-op meter of an unconfigured process. */
  stop(): Promise<void>;
}

export function recordMetrics(): RecordedMetrics {
  const reader = new OnDemandReader();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return {
    async histogram(name) {
      const { resourceMetrics } = await reader.collect();
      const metric = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .find((candidate) => candidate.descriptor.name === name);
      if (metric === undefined) return [];
      if (metric.dataPointType !== DataPointType.HISTOGRAM) {
        throw new Error(`${name} is not a histogram`);
      }
      return metric.dataPoints;
    },
    async stop() {
      metrics.disable();
      await provider.shutdown();
    },
  };
}
