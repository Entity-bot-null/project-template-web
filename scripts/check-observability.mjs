// `pnpm observability:check` and the CI job "Observability as code": the
// dashboards and alert rules of observability/ are code, and are checked like
// code (docs/observability.md#dashboards-and-alerts-as-code):
//
//   1. dashboards: valid JSON, unique uids and panel ids, every datasource
//      reference is the dashboard's Prometheus variable, every variable a
//      query uses is defined;
//   2. alerts: a severity (critical or warning), a runbook_url to a section of
//      docs/incident-response.md that exists, the dashboard_uid of a
//      dashboard that exists, a summary and a description; and at least one
//      unit test in observability/prometheus/tests expects each to fire;
//   3. metric names: every metric a dashboard or rule reads is one the API
//      exports (observability/api-metrics.json, which
//      apps/api/src/observability/metrics-catalog.spec.ts keeps in step with
//      the code) or one a recording rule writes;
//   4. promtool, from the pinned image of scripts/tool-images/Dockerfile:
//      the Prometheus configuration, the rule files (lint findings fatal),
//      every dashboard expression compiled into a rule file so Prometheus'
//      own parser reads it, and the rules' unit tests. Needs Docker, like
//      pnpm lint:workflows.
//
//   node scripts/check-observability.mjs --update-catalog <prometheus URL> [--job api]
//
// rewrites observability/api-metrics.json from the series a running backend
// holds for the API (the local one: docker compose --profile observability,
// with traffic that exercises every metric; docs/observability.md#metric-catalog).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runTool } from './tool-image.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OBSERVABILITY = join(ROOT, 'observability');
const PROMETHEUS = join(OBSERVABILITY, 'prometheus');
const CATALOG = join(OBSERVABILITY, 'api-metrics.json');
const RUNBOOKS = 'docs/incident-response.md';

export const SEVERITIES = ['critical', 'warning'];

/** The datasource reference every panel, query and variable uses. */
export const PROMETHEUS_DATASOURCE = { type: 'prometheus', uid: '${datasource}' };
/** Grafana's own annotation source ("Annotations & Alerts"), present in every dashboard. */
const GRAFANA_DATASOURCE = { type: 'grafana', uid: '-- Grafana --' };

/** Series Prometheus writes itself, readable by any dashboard. */
const BUILTIN_SERIES = new Set(['ALERTS', 'ALERTS_FOR_STATE']);
/** Series a backend writes next to an application's (OTLP resource attributes, alerts). */
const BACKEND_SERIES = new Set([...BUILTIN_SERIES, 'target_info']);

/**
 * Values that stand in for Grafana's built-in variables when a dashboard
 * expression is handed to Prometheus' parser.
 */
const BUILTIN_VARIABLES = new Map([
  ['__rate_interval', '5m'],
  ['__interval', '1m'],
  ['__range', '1h'],
  ['__range_s', '3600'],
  ['__range_ms', '3600000'],
  ['__interval_ms', '60000'],
]);

// PromQL words that look like identifiers but are not metric names.
const PROMQL_WORDS = new Set([
  'and',
  'or',
  'unless',
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'bool',
  'offset',
  'atan2',
  'inf',
  'nan',
  // Aggregation operators, which may be followed by a by/without clause
  // instead of their parenthesis.
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'group',
  'stddev',
  'stdvar',
  'topk',
  'bottomk',
  'quantile',
  'count_values',
  'limitk',
  'limit_ratio',
]);

/**
 * The anchor GitHub gives a Markdown heading: lowercase, punctuation other
 * than "-" and "_" removed, spaces turned into "-".
 * @param {string} heading
 */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Every heading anchor of a Markdown document.
 * @param {string} markdown
 */
export function headingAnchors(markdown) {
  const anchors = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1]) anchors.add(slugify(heading[1]));
  }
  return anchors;
}

/**
 * The metric names a PromQL expression reads. Strings, label matchers,
 * label lists, durations and numbers are removed first; what is left that
 * is not a function call or a PromQL keyword is a metric name.
 * @param {string} expr
 * @returns {string[]}
 */
export function metricNames(expr) {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""')
    .replace(/#[^\n]*/g, '')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(
      /\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^()]*\)/g,
      (match) => match.split('(')[0] ?? '',
    )
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\boffset\s+-?\w+/g, ' ')
    .replace(/(?<![\w:])(?:0x[0-9a-f]+|\d+(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?)/gi, ' ');
  const names = new Set();
  for (const match of stripped.matchAll(/(?<![\w:])([a-zA-Z_:][\w:]*)(\s*\()?/g)) {
    const [, name, call] = match;
    if (name === undefined || call !== undefined) continue;
    if (PROMQL_WORDS.has(name.toLowerCase())) continue;
    names.add(name);
  }
  return [...names];
}

/**
 * A Grafana query with its variables replaced, ready for Prometheus' parser,
 * and the variables it uses that the dashboard does not define.
 * @param {string} expr
 * @param {Map<string, string>} variables name -> stand-in value
 * @returns {{ expr: string; undefined: string[] }}
 */
export function interpolate(expr, variables) {
  /** @type {Set<string>} */
  const missing = new Set();
  const value = (/** @type {string} */ name, /** @type {string} */ match) => {
    // "${1}" is a capture group of label_replace, not a variable.
    if (/^\d+$/.test(name)) return match;
    const known = BUILTIN_VARIABLES.get(name) ?? variables.get(name);
    if (known === undefined) {
      missing.add(name);
      return match;
    }
    return known;
  };
  const replaced = expr.replace(
    /\$\{(\w+)(?::[^}]*)?\}|\[\[(\w+)(?::[^\]]*)?\]\]|\$(\w+)/g,
    (match, braced, bracketed, plain) => value(braced ?? bracketed ?? plain, match),
  );
  return { expr: replaced, undefined: [...missing] };
}

/**
 * The PromQL inside a Prometheus variable query: label_values(<selector>,
 * <label>) reads a selector, query_result(<expr>) an expression.
 * @param {unknown} query
 * @returns {string | undefined} undefined when the query reads no series
 */
export function variableExpression(query) {
  const text =
    typeof query === 'string'
      ? query
      : typeof query === 'object' && query !== null && 'query' in query
        ? String(query.query)
        : '';
  const labelValues = /^\s*label_values\(\s*(.+?)\s*,\s*[\w.]+\s*\)\s*$/s.exec(text);
  if (labelValues) return labelValues[1];
  if (/^\s*label_values\(\s*[\w.]+\s*\)\s*$/.test(text)) return undefined;
  const queryResult = /^\s*query_result\(\s*(.+)\s*\)\s*$/s.exec(text);
  if (queryResult) return queryResult[1];
  throw new Error(`unsupported variable query "${text}" (label_values or query_result)`);
}

/**
 * @typedef {{ file: string; where: string; expr: string }} Expression
 * @typedef {{ uid: string; problems: string[]; expressions: Expression[] }} DashboardReport
 */

/**
 * Checks one dashboard and collects its PromQL expressions, with variables
 * replaced by stand-ins.
 * @param {any} dashboard parsed JSON
 * @param {string} file for messages
 * @returns {DashboardReport}
 */
export function checkDashboard(dashboard, file) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Expression[]} */
  const expressions = [];
  if (typeof dashboard?.uid !== 'string' || !/^[a-zA-Z0-9-_]{1,40}$/.test(dashboard.uid)) {
    problems.push(`${file}: "uid" must be 1 to 40 letters, digits, "-" or "_"`);
  }
  if (typeof dashboard?.title !== 'string' || dashboard.title.length === 0) {
    problems.push(`${file}: "title" is missing`);
  }

  const variables = /** @type {any[]} */ (dashboard?.templating?.list ?? []);
  const source = variables.find((variable) => variable.name === 'datasource');
  if (source?.type !== 'datasource' || source.query !== 'prometheus') {
    problems.push(
      `${file}: needs a "datasource" variable of type datasource for Prometheus, which every query uses (so the dashboard imports into any Grafana)`,
    );
  }
  /** @type {Map<string, string>} */
  const standIns = new Map();
  for (const variable of variables) {
    // Query and custom variables are matched with =~ or = inside quotes;
    // an interval variable stands for a duration.
    standIns.set(variable.name, variable.type === 'interval' ? '5m' : 'value');
  }

  // Every datasource reference, wherever it is (panels, targets, variables).
  const walk = (/** @type {unknown} */ node, /** @type {string} */ path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'datasource') {
        const ok =
          isSameReference(value, PROMETHEUS_DATASOURCE) ||
          (path.includes('.annotations') && isSameReference(value, GRAFANA_DATASOURCE));
        if (!ok) {
          problems.push(
            `${file}: ${path}.datasource must be ${JSON.stringify(PROMETHEUS_DATASOURCE)}, not ${JSON.stringify(value)}`,
          );
        }
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(dashboard, '$');

  const add = (/** @type {string} */ where, /** @type {string} */ expr) => {
    const result = interpolate(expr, standIns);
    for (const name of result.undefined) {
      problems.push(`${file}: ${where} uses $${name}, which the dashboard does not define`);
    }
    expressions.push({ file, where, expr: result.expr });
  };

  for (const variable of variables) {
    if (variable.type !== 'query') continue;
    try {
      const expr = variableExpression(variable.query);
      if (expr !== undefined) add(`variable "${variable.name}"`, expr);
    } catch (error) {
      problems.push(
        `${file}: variable "${variable.name}": ${/** @type {Error} */ (error).message}`,
      );
    }
  }

  /** @type {Set<number>} */
  const ids = new Set();
  const panels = flattenPanels(dashboard?.panels ?? []);
  for (const panel of panels) {
    if (ids.has(panel.id)) problems.push(`${file}: panel id ${panel.id} is used twice`);
    ids.add(panel.id);
    if (panel.type === 'row') continue;
    const targets = /** @type {any[]} */ (panel.targets ?? []);
    if (targets.length === 0) problems.push(`${file}: panel "${panel.title}" has no query`);
    for (const target of targets) {
      if (typeof target.expr !== 'string' || target.expr.trim() === '') {
        problems.push(`${file}: panel "${panel.title}" query ${target.refId} has no expression`);
        continue;
      }
      add(`panel "${panel.title}" query ${target.refId}`, target.expr);
    }
  }
  return { uid: dashboard?.uid, problems, expressions };
}

/**
 * @param {any[]} panels
 * @returns {any[]}
 */
function flattenPanels(panels) {
  return panels.flatMap((panel) => [panel, ...flattenPanels(panel.panels ?? [])]);
}

/**
 * @param {unknown} value
 * @param {{ type: string; uid: string }} expected
 */
function isSameReference(value, expected) {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 2 &&
    /** @type {any} */ (value).type === expected.type &&
    /** @type {any} */ (value).uid === expected.uid
  );
}

/**
 * @typedef {{ alert?: string; record?: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }} Rule
 * @typedef {{ name: string; rules: Rule[] }} RuleGroup
 */

/**
 * Checks the alerts of one rule file against the runbooks and dashboards.
 * @param {RuleGroup[]} groups
 * @param {string} file
 * @param {{ anchors: Set<string>; dashboardUids: Set<string> }} context
 */
export function checkAlerts(groups, file, { anchors, dashboardUids }) {
  /** @type {string[]} */
  const problems = [];
  for (const group of groups) {
    for (const rule of group.rules) {
      if (rule.alert === undefined) continue;
      const where = `${file}: alert ${rule.alert}`;
      const severity = rule.labels?.severity;
      if (severity === undefined || !SEVERITIES.includes(severity)) {
        problems.push(`${where}: label "severity" must be one of ${SEVERITIES.join(', ')}`);
      }
      for (const key of ['summary', 'description']) {
        if (!rule.annotations?.[key]) problems.push(`${where}: annotation "${key}" is missing`);
      }
      const runbook = rule.annotations?.runbook_url ?? '';
      const anchor = runbook.startsWith(`${RUNBOOKS}#`) ? runbook.slice(RUNBOOKS.length + 1) : '';
      if (!anchors.has(anchor)) {
        problems.push(
          `${where}: runbook_url "${runbook}" must be ${RUNBOOKS}#<section>, a heading that exists`,
        );
      }
      const uid = rule.annotations?.dashboard_uid ?? '';
      if (!dashboardUids.has(uid)) {
        problems.push(
          `${where}: dashboard_uid "${uid}" is not a dashboard of observability/grafana`,
        );
      }
    }
  }
  return problems;
}

/**
 * The series names a catalog entry stands for.
 * @param {string} name
 * @param {{ type: string }} metric
 */
export function seriesNames(name, metric) {
  return metric.type === 'histogram' ? [`${name}_bucket`, `${name}_count`, `${name}_sum`] : [name];
}

/**
 * A rule file holding every dashboard expression as a recording rule, one
 * group per query, so promtool parses them and names the panel of any error.
 * @param {Expression[]} expressions
 */
export function dashboardRuleFile(expressions) {
  return stringifyYaml({
    groups: expressions.map(({ file, where, expr }, index) => ({
      name: `${index + 1}: ${file} ${where}`,
      rules: [{ record: `dashboard:expression:${index + 1}`, expr }],
    })),
  });
}

/**
 * The alerts that some unit test expects to fire.
 * @param {any[]} testFiles parsed test files
 */
export function testedAlerts(testFiles) {
  const tested = new Set();
  for (const testFile of testFiles) {
    for (const test of testFile?.tests ?? []) {
      for (const alertTest of test.alert_rule_test ?? []) {
        if ((alertTest.exp_alerts ?? []).length > 0) tested.add(alertTest.alertname);
      }
    }
  }
  return tested;
}

/**
 * The catalog of observability/api-metrics.json from a series listing: one
 * entry per metric with its type and attribute labels (resource labels such
 * as job, instance or service_version are the deployment's, not the metric's).
 * @param {Record<string, string>[]} series
 * @param {Set<string>} resourceLabels
 */
export function catalogFromSeries(series, resourceLabels) {
  /** @type {Map<string, { suffixes: Set<string>; labels: Set<string> }>} */
  const byBase = new Map();
  for (const labels of series) {
    const name = labels.__name__ ?? '';
    // Recording rules (level:metric:operation), alerts and the resource
    // series target_info are written by the backend, not exported by the API.
    if (name.includes(':') || BACKEND_SERIES.has(name)) continue;
    const histogramPart = /^(.+)_(bucket|count|sum)$/.exec(name);
    const base = histogramPart?.[1] ?? name;
    const entry = byBase.get(base) ?? { suffixes: new Set(), labels: new Set() };
    entry.suffixes.add(histogramPart?.[2] ?? '');
    for (const label of Object.keys(labels)) {
      if (label !== '__name__' && label !== 'le' && !resourceLabels.has(label)) {
        entry.labels.add(label);
      }
    }
    byBase.set(base, entry);
  }
  /** @type {Record<string, { type: string; labels: string[] }>} */
  const metrics = {};
  for (const [base, { suffixes, labels }] of [...byBase].sort(([a], [b]) => a.localeCompare(b))) {
    const histogram = suffixes.has('bucket') && suffixes.has('count') && suffixes.has('sum');
    // A histogram's parts arrive together; a lone "_count" is a metric of its own.
    if (!histogram && !suffixes.has('')) {
      for (const suffix of suffixes) {
        metrics[`${base}_${suffix}`] = { type: 'gauge', labels: [...labels].sort() };
      }
      continue;
    }
    metrics[base] = {
      type: histogram ? 'histogram' : base.endsWith('_total') ? 'counter' : 'gauge',
      labels: [...labels].sort(),
    };
  }
  return metrics;
}

/** @param {string} path */
function readYaml(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

/** @param {string} dir @param {RegExp} pattern */
function filesIn(dir, pattern) {
  return readdirSync(dir)
    .filter((file) => pattern.test(file))
    .sort()
    .map((file) => join(dir, file));
}

/** @param {string} path */
const display = (path) => relative(ROOT, path).replaceAll('\\', '/');

/** The resource attributes the backend promotes to labels, as label names. */
function resourceLabels() {
  const config = readYaml(join(PROMETHEUS, 'prometheus.yaml'));
  return new Set([
    'job',
    'instance',
    ...(config?.otlp?.promote_resource_attributes ?? []).map((/** @type {string} */ name) =>
      name.replace(/[^\w]/g, '_'),
    ),
  ]);
}

/**
 * @param {string} url Prometheus base URL
 * @param {string} job
 */
async function updateCatalog(url, job) {
  const endpoint = new URL('api/v1/series', url.endsWith('/') ? url : `${url}/`);
  endpoint.searchParams.set('match[]', `{job="${job}"}`);
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`);
  const { data } = /** @type {{ data: Record<string, string>[] }} */ (await response.json());
  const current = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const metrics = catalogFromSeries(data, resourceLabels());
  // Written as Prettier formats it, so `pnpm format:check` stays green.
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(CATALOG)) ?? {};
  const json = JSON.stringify({ ...current, metrics });
  writeFileSync(CATALOG, await prettier.format(json, { ...options, filepath: CATALOG }));
  console.log(`${display(CATALOG)}: ${Object.keys(metrics).length} metrics of job "${job}".`);
}

/**
 * Steps 1 to 3, without Docker: what is wrong in the observability/ files of
 * a repository laid out like this one (scripts/check-observability.test.mjs
 * runs it on this repository and on broken copies of it).
 * @param {string} [root]
 */
export function checkRepository(root = ROOT) {
  const prometheus = join(root, 'observability', 'prometheus');
  const show = (/** @type {string} */ path) => relative(root, path).replaceAll('\\', '/');
  /** @type {string[]} */
  const problems = [];

  // Dashboards.
  /** @type {Expression[]} */
  const expressions = [];
  /** @type {Map<string, string>} */
  const uids = new Map();
  for (const path of filesIn(join(root, 'observability', 'grafana', 'dashboards'), /\.json$/)) {
    const file = show(path);
    let dashboard;
    try {
      dashboard = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      problems.push(`${file}: invalid JSON: ${/** @type {Error} */ (error).message}`);
      continue;
    }
    const report = checkDashboard(dashboard, file);
    problems.push(...report.problems);
    expressions.push(...report.expressions);
    const other = uids.get(report.uid);
    if (other !== undefined) problems.push(`${file}: uid "${report.uid}" is also used by ${other}`);
    uids.set(report.uid, file);
  }
  const dashboardExpressions = [...expressions];

  // Rules: alerts against runbooks and dashboards; recorded names.
  const anchors = headingAnchors(readFileSync(join(root, RUNBOOKS), 'utf8'));
  const dashboardUids = new Set(uids.keys());
  /** @type {Set<string>} */
  const recorded = new Set();
  /** @type {Set<string>} */
  const alerts = new Set();
  const ruleFiles = filesIn(join(prometheus, 'rules'), /\.ya?ml$/);
  for (const path of ruleFiles) {
    const file = show(path);
    const groups = /** @type {RuleGroup[]} */ (readYaml(path)?.groups ?? []);
    problems.push(...checkAlerts(groups, file, { anchors, dashboardUids }));
    for (const rule of groups.flatMap((group) => group.rules)) {
      if (rule.record !== undefined) recorded.add(rule.record);
      if (rule.alert !== undefined) alerts.add(rule.alert);
      expressions.push({ file, where: rule.alert ?? rule.record ?? '?', expr: rule.expr });
    }
  }

  // Every alert has a unit test that makes it fire.
  const testFiles = filesIn(join(prometheus, 'tests'), /\.ya?ml$/);
  const tested = testedAlerts(testFiles.map(readYaml));
  for (const alert of alerts) {
    if (!tested.has(alert)) {
      problems.push(
        `alert ${alert}: no unit test in observability/prometheus/tests expects it to fire`,
      );
    }
  }

  // Metric names: exported by the API, or written by a recording rule.
  const catalog = JSON.parse(readFileSync(join(root, 'observability', 'api-metrics.json'), 'utf8'));
  const known = new Set([
    ...BUILTIN_SERIES,
    ...recorded,
    ...Object.entries(catalog.metrics).flatMap(([name, metric]) =>
      seriesNames(name, /** @type {{ type: string }} */ (metric)),
    ),
  ]);
  for (const { file, where, expr } of expressions) {
    for (const name of metricNames(expr)) {
      if (!known.has(name)) {
        problems.push(
          `${file}: ${where} reads "${name}", which the API does not export (observability/api-metrics.json) and no recording rule writes`,
        );
      }
    }
  }

  return {
    problems,
    summary: `${uids.size} dashboards, ${alerts.size} alerts, ${recorded.size} recorded series, ${expressions.length} expressions reading known metrics`,
    dashboardExpressions,
    // Relative to observability/prometheus, where promtool runs.
    ruleFiles: ruleFiles.map((path) => relative(prometheus, path).replaceAll('\\', '/')),
    testFiles: testFiles.map((path) => relative(prometheus, path).replaceAll('\\', '/')),
  };
}

function check() {
  const { problems, summary, dashboardExpressions, ruleFiles, testFiles } = checkRepository();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`${problems.length} problem(s) in observability/.`);
    return 1;
  }
  console.log(`ok  ${summary}`);

  // promtool: configuration and rule files, dashboard expressions, unit tests.
  // Only observability/prometheus is mounted: the rule files of the
  // configuration resolve next to it, as in the local backend's container.
  // Lint findings (a rule defined twice) fail like errors.
  /** @param {string[]} args @param {string} [input] standard input */
  const promtool = (args, input) =>
    runTool('promtool', args, {
      entrypoint: 'promtool',
      source: PROMETHEUS,
      mount: '/rules',
      input,
    });
  const lint = ['--lint=all', '--lint-fatal'];
  return (
    promtool(['check', 'config', ...lint, 'prometheus.yaml']) ||
    promtool(['check', 'rules', ...lint, ...ruleFiles]) ||
    promtool(['check', 'rules', ...lint], dashboardRuleFile(dashboardExpressions)) ||
    promtool(['test', 'rules', ...testFiles])
  );
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) {
  const update = process.argv.indexOf('--update-catalog');
  if (update !== -1) {
    const url = process.argv[update + 1];
    const jobFlag = process.argv.indexOf('--job');
    const job = jobFlag === -1 ? 'api' : (process.argv[jobFlag + 1] ?? 'api');
    if (!url) {
      console.error(
        'Usage: node scripts/check-observability.mjs --update-catalog <prometheus URL> [--job api]',
      );
      process.exit(2);
    }
    await updateCatalog(url, job);
  } else {
    process.exit(check());
  }
}
