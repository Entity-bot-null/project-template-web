// Tests of scripts/check-observability.mjs (`node --test scripts/check-observability.test.mjs`):
// the checks that run without Docker (dashboards, alerts, metric names) on
// this repository and on broken copies of it, and the PromQL and Grafana
// helpers they rely on. promtool's part is `pnpm observability:check`.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  catalogFromSeries,
  checkAlerts,
  checkDashboard,
  checkRepository,
  dashboardRuleFile,
  headingAnchors,
  interpolate,
  metricNames,
  PROMETHEUS_DATASOURCE,
  slugify,
  testedAlerts,
  variableExpression,
} from './check-observability.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMP = mkdtempSync(join(tmpdir(), 'observability-test-'));

after(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

describe('runbook anchors', () => {
  test('are the anchors GitHub gives the headings', () => {
    assert.equal(slugify('5. High 5xx rate'), '5-high-5xx-rate');
    assert.equal(slugify('12. External dependency outage'), '12-external-dependency-outage');
    assert.equal(
      slugify('When the budget runs out (REQUIERE CONFIGURACIÓN)'),
      'when-the-budget-runs-out-requiere-configuración',
    );
  });

  test('come from headings only, not from code blocks', () => {
    const anchors = headingAnchors(
      '# Title\n\n### 2. Readiness failing\n\n```\n# not a heading\n```\n',
    );
    assert.deepEqual([...anchors], ['title', '2-readiness-failing']);
  });
});

describe('metricNames', () => {
  /** @type {[string, string[]][]} */
  const cases = [
    [
      'sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="api", le="0.5"}[5m]))',
      ['http_server_request_duration_seconds_bucket'],
    ],
    [
      '(sum(rate(errors_total{code=~"5.."}[5m])) or vector(0)) / sum(rate(requests_total[5m]))',
      ['errors_total', 'requests_total'],
    ],
    ['ratio > 0.5 and on (job) other offset 1h >= 1e-3', ['ratio', 'other']],
    [
      'sum by (class) (label_replace(rate(m_total[5m]), "class", "${1}xx", "code", "([1-5]).."))',
      ['m_total'],
    ],
    [
      'slo:sli_error:ratio_rate5m{slo="a"} / on (slo) group_left () (1 - slo:objective:ratio)',
      ['slo:sli_error:ratio_rate5m', 'slo:objective:ratio'],
    ],
    [
      'absent_over_time(process_cpu_time_seconds_total{job="api"}[10m])',
      ['process_cpu_time_seconds_total'],
    ],
    ['count without (instance) (up)', ['up']],
    ['topk(5, sum(x) by (y))', ['x']],
    ['histogram_quantile(0.95, sum by (le) (rate(h_bucket[$__rate_interval])))', ['h_bucket']],
    ['1 - (a / b)', ['a', 'b']],
    ['max(ALERTS{alertname=~"Api.*", alertstate="firing"})', ['ALERTS']],
  ];
  for (const [expr, expected] of cases) {
    test(expr, () => {
      assert.deepEqual(metricNames(expr), expected);
    });
  }
});

describe('interpolate', () => {
  const variables = new Map([
    ['job', 'value'],
    ['environment', 'value'],
  ]);

  test('replaces every variable syntax, built-in ones included', () => {
    const { expr, undefined: missing } = interpolate(
      'rate(m{job="$job", a="${environment}", b=~"${environment:regex}", c="[[job]]"}[$__rate_interval])',
      variables,
    );
    assert.equal(expr, 'rate(m{job="value", a="value", b=~"value", c="value"}[5m])');
    assert.deepEqual(missing, []);
  });

  test('keeps capture groups of label_replace and reports unknown variables', () => {
    const { expr, undefined: missing } = interpolate(
      'label_replace(m{x="$nope"}, "d", "${1}xx", "s", "(.)")',
      variables,
    );
    assert.equal(expr, 'label_replace(m{x="$nope"}, "d", "${1}xx", "s", "(.)")');
    assert.deepEqual(missing, ['nope']);
  });
});

describe('variableExpression', () => {
  test('reads the selector of label_values, commas inside it included', () => {
    assert.equal(
      variableExpression(
        'label_values(m_count{job="$job", x=~"a,b"}, deployment_environment_name)',
      ),
      'm_count{job="$job", x=~"a,b"}',
    );
    assert.equal(variableExpression({ qryType: 1, query: 'label_values(m, job)' }), 'm');
    assert.equal(variableExpression('query_result(sum(m))'), 'sum(m)');
  });

  test('has nothing to check for a bare label, and refuses other queries', () => {
    assert.equal(variableExpression('label_values(job)'), undefined);
    assert.throws(() => variableExpression('metrics(.*)'), /unsupported variable query/);
  });
});

/**
 * A dashboard that passes, to break one thing at a time.
 * @returns {any}
 */
function dashboard() {
  return {
    uid: 'test-dashboard',
    title: 'Test',
    annotations: {
      list: [
        {
          builtIn: 1,
          datasource: { type: 'grafana', uid: '-- Grafana --' },
          name: 'Annotations & Alerts',
        },
      ],
    },
    templating: {
      list: [
        { name: 'datasource', type: 'datasource', query: 'prometheus' },
        {
          name: 'job',
          type: 'query',
          datasource: PROMETHEUS_DATASOURCE,
          query: 'label_values(requests_total, job)',
        },
      ],
    },
    panels: [
      { id: 1, type: 'row', title: 'Row', panels: [] },
      {
        id: 2,
        type: 'timeseries',
        title: 'Requests',
        datasource: PROMETHEUS_DATASOURCE,
        targets: [
          {
            refId: 'A',
            datasource: PROMETHEUS_DATASOURCE,
            expr: 'sum(rate(requests_total{job="$job"}[$__rate_interval]))',
          },
        ],
      },
    ],
  };
}

describe('checkDashboard', () => {
  test('passes a dashboard that reads Prometheus through its variable, and collects its queries', () => {
    const report = checkDashboard(dashboard(), 'test.json');
    assert.deepEqual(report.problems, []);
    assert.deepEqual(
      report.expressions.map(({ where, expr }) => [where, expr]),
      [
        ['variable "job"', 'requests_total'],
        ['panel "Requests" query A', 'sum(rate(requests_total{job="value"}[5m]))'],
      ],
    );
  });

  test('refuses a datasource chosen by uid: the dashboard would not import elsewhere', () => {
    const broken = dashboard();
    broken.panels[1].targets[0].datasource = { type: 'prometheus', uid: 'prometheus' };
    const { problems } = checkDashboard(broken, 'test.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /\$\.panels\[1\]\.targets\[0\]\.datasource must be/);
  });

  test('requires the datasource variable', () => {
    const broken = dashboard();
    broken.templating.list.shift();
    assert.match(
      checkDashboard(broken, 'test.json').problems.join('\n'),
      /needs a "datasource" variable/,
    );
  });

  test('reports undefined variables, duplicate panel ids and empty queries', () => {
    const broken = dashboard();
    broken.panels.push({
      id: 2,
      type: 'stat',
      title: 'Broken',
      datasource: PROMETHEUS_DATASOURCE,
      targets: [
        {
          refId: 'A',
          datasource: PROMETHEUS_DATASOURCE,
          expr: 'sum(requests_total{env="$environment"})',
        },
        { refId: 'B', datasource: PROMETHEUS_DATASOURCE, expr: '' },
      ],
    });
    const { problems } = checkDashboard(broken, 'test.json');
    assert.deepEqual(problems, [
      'test.json: panel id 2 is used twice',
      'test.json: panel "Broken" query A uses $environment, which the dashboard does not define',
      'test.json: panel "Broken" query B has no expression',
    ]);
  });
});

describe('checkAlerts', () => {
  const context = { anchors: new Set(['5-high-5xx-rate']), dashboardUids: new Set(['app-api']) };
  const alert = (/** @type {Record<string, unknown>} */ overrides) => [
    {
      name: 'group',
      rules: [
        {
          alert: 'Example',
          expr: 'up == 0',
          labels: { severity: 'critical' },
          annotations: {
            summary: 'Something',
            description: 'Details',
            runbook_url: 'docs/incident-response.md#5-high-5xx-rate',
            dashboard_uid: 'app-api',
          },
          ...overrides,
        },
      ],
    },
  ];

  test('passes an alert with a severity, a runbook section and a dashboard', () => {
    assert.deepEqual(checkAlerts(alert({}), 'rules.yaml', context), []);
  });

  test('reports a missing or unknown severity, runbook section, dashboard and text', () => {
    const problems = checkAlerts(
      alert({
        labels: { severity: 'page' },
        annotations: { runbook_url: 'docs/incident-response.md#99-nothing', dashboard_uid: 'gone' },
      }),
      'rules.yaml',
      context,
    );
    assert.deepEqual(problems, [
      'rules.yaml: alert Example: label "severity" must be one of critical, warning',
      'rules.yaml: alert Example: annotation "summary" is missing',
      'rules.yaml: alert Example: annotation "description" is missing',
      'rules.yaml: alert Example: runbook_url "docs/incident-response.md#99-nothing" must be docs/incident-response.md#<section>, a heading that exists',
      'rules.yaml: alert Example: dashboard_uid "gone" is not a dashboard of observability/grafana',
    ]);
  });
});

test('an alert counts as tested only by a test that expects it to fire', () => {
  const tested = testedAlerts([
    {
      tests: [
        {
          alert_rule_test: [
            { alertname: 'Fires', exp_alerts: [{ exp_labels: {} }] },
            { alertname: 'NeverExpected', exp_alerts: [] },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual([...tested], ['Fires']);
});

test('the catalog is built from a series listing: types, attribute labels, nothing of the backend', () => {
  /** @type {Record<string, string>[]} */
  const series = [
    {
      __name__: 'http_server_request_duration_seconds_bucket',
      job: 'api',
      instance: 'i',
      http_route: '/a',
      le: '0.5',
    },
    {
      __name__: 'http_server_request_duration_seconds_count',
      job: 'api',
      instance: 'i',
      http_route: '/a',
    },
    {
      __name__: 'http_server_request_duration_seconds_sum',
      job: 'api',
      instance: 'i',
      http_route: '/a',
    },
    {
      __name__: 'app_server_errors_total',
      job: 'api',
      error_origin: 'database',
      service_version: 'abc',
    },
    { __name__: 'db_client_connection_count', job: 'api', db_client_connection_state: 'idle' },
    { __name__: 'process_memory_usage_bytes', job: 'api' },
    { __name__: 'slo:sli_error:ratio_rate5m', job: 'api', slo: 'api-availability' },
    { __name__: 'target_info', job: 'api', host_arch: 'amd64' },
    { __name__: 'ALERTS', job: 'api', alertname: 'X' },
  ];
  assert.deepEqual(catalogFromSeries(series, new Set(['job', 'instance', 'service_version'])), {
    app_server_errors_total: { type: 'counter', labels: ['error_origin'] },
    db_client_connection_count: { type: 'gauge', labels: ['db_client_connection_state'] },
    http_server_request_duration_seconds: { type: 'histogram', labels: ['http_route'] },
    process_memory_usage_bytes: { type: 'gauge', labels: [] },
  });
});

test('dashboard expressions become a rule file promtool can read, one group per query', () => {
  const file = parseYaml(
    dashboardRuleFile([
      { file: 'a.json', where: 'panel "One" query A', expr: 'sum(x)' },
      { file: 'a.json', where: 'panel "One" query A', expr: 'sum(y)' },
    ]),
  );
  assert.deepEqual(file, {
    groups: [
      {
        name: '1: a.json panel "One" query A',
        rules: [{ record: 'dashboard:expression:1', expr: 'sum(x)' }],
      },
      {
        name: '2: a.json panel "One" query A',
        rules: [{ record: 'dashboard:expression:2', expr: 'sum(y)' }],
      },
    ],
  });
});

describe('checkRepository', () => {
  test('finds nothing wrong in this repository', () => {
    const { problems, testFiles } = checkRepository(ROOT);
    assert.deepEqual(problems, []);
    assert.ok(testFiles.length > 0);
  });

  test('catches an unknown metric, a missing runbook section and an untested alert in a copy', () => {
    const copy = join(TEMP, 'repo');
    cpSync(join(ROOT, 'observability'), join(copy, 'observability'), { recursive: true });
    cpSync(join(ROOT, 'docs', 'incident-response.md'), join(copy, 'docs', 'incident-response.md'));
    const dashboardFile = join(copy, 'observability', 'grafana', 'dashboards', 'api-service.json');
    const api = JSON.parse(readFileSync(dashboardFile, 'utf8'));
    const panel = api.panels.find((/** @type {any} */ p) => p.type !== 'row');
    panel.targets[0].expr = 'sum(rate(made_up_metric_total[$__rate_interval]))';
    writeFileSync(dashboardFile, JSON.stringify(api));
    const rulesFile = join(copy, 'observability', 'prometheus', 'rules', 'extra.yaml');
    writeFileSync(
      rulesFile,
      [
        'groups:',
        '  - name: extra',
        '    rules:',
        '      - alert: Untested',
        '        expr: up == 0',
        '        labels: { severity: warning }',
        '        annotations:',
        '          summary: s',
        '          description: d',
        '          runbook_url: docs/incident-response.md#no-such-section',
        '          dashboard_uid: app-api',
        '',
      ].join('\n'),
    );
    const { problems } = checkRepository(copy);
    assert.deepEqual(problems, [
      'observability/prometheus/rules/extra.yaml: alert Untested: runbook_url "docs/incident-response.md#no-such-section" must be docs/incident-response.md#<section>, a heading that exists',
      'alert Untested: no unit test in observability/prometheus/tests expects it to fire',
      `observability/grafana/dashboards/api-service.json: panel "${panel.title}" query A reads "made_up_metric_total", which the API does not export (observability/api-metrics.json) and no recording rule writes`,
      'observability/prometheus/rules/extra.yaml: Untested reads "up", which the API does not export (observability/api-metrics.json) and no recording rule writes',
    ]);
  });
});
