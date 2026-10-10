import { type RuntimeConfig, runtimeConfig } from './runtimeConfig';

// Real-user Web Vitals (docs/observability.md#web-vitals): LCP, INP, CLS, FCP
// and TTFB of this page load, measured in the browser by the web-vitals
// library and reported to the API, which records them as metrics. Started
// after the first render, never in its way: this module and the library are
// separate chunks, and the library is fetched only when the deployment
// samples this page load (WEB_VITALS_SAMPLE_RATE in /app-config.json; 0 is
// off, and nothing is loaded).

export interface WebVitalsOptions {
  loadConfig?: () => Promise<RuntimeConfig>;
  loadReporter?: () => Promise<{ reportWebVitals: (pathname: string) => void }>;
  /** 0 (inclusive) to 1 (exclusive), like Math.random. */
  random?: () => number;
}

/** Starts reporting if this page load is sampled. Never throws. */
export async function startWebVitals({
  loadConfig = runtimeConfig,
  loadReporter = () => import('./webVitalsReporter'),
  random = Math.random,
}: WebVitalsOptions = {}): Promise<boolean> {
  const pathname = landingPath();
  try {
    const sampleRate = (await loadConfig()).webVitals?.sampleRate ?? 0;
    if (random() >= sampleRate) return false;
    (await loadReporter()).reportWebVitals(pathname);
    return true;
  } catch (error) {
    console.error('Web Vitals could not start', error);
    return false;
  }
}

/**
 * The path of the document as loaded: the metrics belong to the page load,
 * like in the Chrome UX Report, not to a route the app navigated to since
 * (a sign-in redirect, a click).
 */
export function landingPath(): string {
  const navigation = performance.getEntriesByType('navigation')[0];
  return navigation === undefined ? window.location.pathname : new URL(navigation.name).pathname;
}
