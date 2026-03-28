import type { RunReport } from "../types";

export async function writeDashboard(report: RunReport, outputPath: string): Promise<void> {
  await Bun.write(outputPath, renderDashboard(report));
}

function renderDashboard(report: RunReport): string {
  const reportJson = JSON.stringify(report).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Endpoint Tester Dashboard</title>
    <style>
      :root {
        --bg: #0a0d12;
        --panel: #11161e;
        --panel-2: #171d27;
        --grid: rgba(138, 157, 184, 0.12);
        --text: #e7edf7;
        --muted: #9aa7ba;
        --valid: #3ddc97;
        --invalid: #ff7b72;
        --scopes: #f2cc60;
        --error: #79c0ff;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 16px;
        color: var(--text);
        background:
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
          radial-gradient(circle at top, #162030 0%, var(--bg) 52%);
        background-size: 24px 24px, 24px 24px, auto;
        font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
      }

      .shell {
        width: min(1480px, 100%);
        min-height: calc(100vh - 32px);
        margin: 0 auto;
        border: 1px solid var(--grid);
        border-radius: 18px;
        overflow: hidden;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        background: rgba(10, 13, 18, 0.94);
        backdrop-filter: blur(12px);
      }

      .shell-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 18px;
        background: var(--panel);
        border-bottom: 1px solid var(--grid);
      }

      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
      }

      .red { background: #ff5f56; }
      .yellow { background: #ffbd2e; }
      .green { background: #27c93f; }

      .title {
        margin-left: 12px;
        color: var(--muted);
        font-size: 13px;
      }

      .layout {
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
        min-height: calc(100vh - 81px);
      }

      .sidebar {
        padding: 24px;
        border-right: 1px solid var(--grid);
        background: linear-gradient(180deg, rgba(17, 22, 30, 0.95), rgba(12, 16, 22, 0.95));
      }

      .main {
        padding: 24px;
        display: grid;
        gap: 18px;
      }

      h1 {
        margin: 0 0 14px;
        font-size: clamp(30px, 4vw, 54px);
        line-height: 0.95;
      }

      .meta {
        color: var(--muted);
        line-height: 1.7;
        font-size: 14px;
      }

      .section-title {
        margin: 24px 0 14px;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .cards {
        display: grid;
        gap: 12px;
      }

      .card {
        padding: 16px;
        border-radius: 16px;
        background: var(--panel);
        border: 1px solid var(--grid);
      }

      .card .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .card .value {
        margin-top: 10px;
        font-size: 36px;
        font-weight: 700;
      }

      .valid { color: var(--valid); }
      .invalid_endpoint { color: var(--invalid); }
      .insufficient_scopes { color: var(--scopes); }
      .error { color: var(--error); }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding: 16px;
        border-radius: 16px;
        background: var(--panel);
        border: 1px solid var(--grid);
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      button {
        border: 1px solid rgba(138, 157, 184, 0.16);
        background: var(--panel-2);
        color: var(--text);
        border-radius: 999px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }

      button.active {
        background: rgba(61, 220, 151, 0.12);
        border-color: rgba(61, 220, 151, 0.45);
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .chip {
        display: inline-flex;
        padding: 7px 10px;
        border-radius: 999px;
        background: var(--panel-2);
        border: 1px solid var(--grid);
        color: var(--muted);
        font-size: 12px;
      }

      .panel {
        border-radius: 16px;
        overflow: hidden;
        background: var(--panel);
        border: 1px solid var(--grid);
      }

      .panel-header {
        padding: 14px 16px;
        border-bottom: 1px solid var(--grid);
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .table-wrap {
        overflow: auto;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      th, td {
        padding: 14px 16px;
        border-bottom: 1px solid var(--grid);
        text-align: left;
        vertical-align: top;
        font-size: 13px;
      }

      thead th {
        background: rgba(17, 22, 30, 0.98);
        position: sticky;
        top: 0;
        z-index: 1;
      }

      th:nth-child(1), td:nth-child(1) { width: 16%; }
      th:nth-child(2), td:nth-child(2) { width: 20%; }
      th:nth-child(3), td:nth-child(3) { width: 21%; }
      th:nth-child(4), td:nth-child(4) { width: 10%; }
      th:nth-child(5), td:nth-child(5) { width: 18%; }
      th:nth-child(6), td:nth-child(6) { width: 16%; }

      .row-title {
        color: var(--text);
        margin-bottom: 4px;
        word-break: break-word;
      }

      .row-subtitle {
        color: var(--muted);
        word-break: break-word;
      }

      .summary-box {
        max-height: 140px;
        overflow: auto;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(23, 29, 39, 0.7);
        border: 1px solid var(--grid);
        line-height: 1.5;
        word-break: break-word;
      }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
        line-height: 1.35;
      }

      .status-pill::before {
        content: "";
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: currentColor;
      }

      .empty {
        padding: 22px;
        color: var(--muted);
      }

      @media (max-width: 1100px) {
        .layout {
          grid-template-columns: 1fr;
        }

        .sidebar {
          border-right: 0;
          border-bottom: 1px solid var(--grid);
        }
      }

      @media (max-width: 820px) {
        body {
          padding: 0;
        }

        .shell {
          border-radius: 0;
          border-left: 0;
          border-right: 0;
          min-height: 100vh;
        }

        .main, .sidebar {
          padding: 16px;
        }

        table {
          min-width: 1280px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="shell-bar">
        <span class="dot red"></span>
        <span class="dot yellow"></span>
        <span class="dot green"></span>
        <span class="title">endpoint-tester dashboard</span>
      </div>

      <div class="layout">
        <aside class="sidebar">
          <h1>Endpoint Test Dashboard</h1>
          <div class="meta">
            Generated: ${escapeHtml(report.generatedAt)}<br />
            Mode: ${escapeHtml(report.execution.mode)}<br />
            Toolkit concurrency: ${escapeHtml(String(report.execution.toolkitConcurrency))}<br />
            Cooldown: ${escapeHtml(String(report.execution.perToolkitCooldownMs))}ms<br />
            Max retries: ${escapeHtml(String(report.execution.maxRetries))}
          </div>

          <div class="section-title">Summary</div>
          <div class="cards">
            ${renderSummaryCard("valid", report.summary.valid)}
            ${renderSummaryCard("invalid endpoint", report.summary.invalid_endpoint, "invalid_endpoint")}
            ${renderSummaryCard("insufficient scopes", report.summary.insufficient_scopes, "insufficient_scopes")}
            ${renderSummaryCard("error", report.summary.error)}
          </div>
        </aside>

        <main class="main">
          <section class="toolbar">
            <div class="filters" id="filters"></div>
            <div class="chips" id="quick-stats"></div>
          </section>

          <section class="panel">
            <div class="panel-header">Endpoints</div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Endpoint</th>
                    <th>Action</th>
                    <th>Attempts</th>
                    <th>Summary</th>
                    <th>Scope Suggestions</th>
                  </tr>
                </thead>
                <tbody id="results-body"></tbody>
              </table>
              <div id="empty-state" class="empty" hidden>No endpoints match the selected filter.</div>
            </div>
          </section>
        </main>
      </div>
    </div>

    <script>
      const report = ${reportJson};
      const filters = [
        { key: "all", label: "all" },
        { key: "valid", label: "success" },
        { key: "invalid_endpoint", label: "invalid" },
        { key: "insufficient_scopes", label: "insufficient scopes" },
        { key: "error", label: "error" }
      ];

      let activeFilter = "all";
      const filtersEl = document.getElementById("filters");
      const quickStatsEl = document.getElementById("quick-stats");
      const resultsBodyEl = document.getElementById("results-body");
      const emptyStateEl = document.getElementById("empty-state");

      renderFilters();
      renderStats();
      renderTable();

      function renderFilters() {
        filtersEl.innerHTML = filters.map((filter) => {
          const count = filter.key === "all"
            ? report.results.length
            : report.results.filter((result) => result.status === filter.key).length;
          const activeClass = filter.key === activeFilter ? "active" : "";
          return '<button class="' + activeClass + '" data-filter="' + filter.key + '">' + escapeHtml(filter.label) + ' (' + count + ')</button>';
        }).join("");

        for (const button of filtersEl.querySelectorAll("button")) {
          button.addEventListener("click", () => {
            activeFilter = button.dataset.filter;
            renderFilters();
            renderStats();
            renderTable();
          });
        }
      }

      function renderStats() {
        const visibleResults = getVisibleResults();
        const retriedCount = visibleResults.filter((result) => result.retried).length;
        quickStatsEl.innerHTML = [
          '<span class="chip">Showing ' + visibleResults.length + ' of ' + report.results.length + ' endpoints</span>',
          '<span class="chip">Retried: ' + retriedCount + '</span>',
          '<span class="chip">Successful: ' + report.summary.valid + '</span>',
          '<span class="chip">Invalid: ' + report.summary.invalid_endpoint + '</span>'
        ].join("");
      }

      function renderTable() {
        const visibleResults = getVisibleResults();
        emptyStateEl.hidden = visibleResults.length !== 0;
        resultsBodyEl.innerHTML = visibleResults.map(renderRow).join("");
      }

      function getVisibleResults() {
        return report.results.filter((result) => activeFilter === "all" ? true : result.status === activeFilter);
      }

      function renderRow(result) {
        const suggestions = result.scopeSuggestions.length
          ? '<div class="summary-box">' + result.scopeSuggestions.map(escapeHtml).join('<br /><br />') + '</div>'
          : '<div class="row-subtitle">No scope suggestions needed</div>';

        return [
          '<tr>',
          '<td><span class="status-pill ' + escapeHtml(result.status) + '">' + escapeHtml(result.status.replaceAll("_", " ")) + '</span></td>',
          '<td><div class="row-title">' + escapeHtml(result.toolSlug) + '</div><div class="row-subtitle">' + escapeHtml(result.method + " " + result.path) + '</div></td>',
          '<td><div class="row-title">' + escapeHtml(result.resolvedActionName || "n/a") + '</div><div class="row-subtitle">' + escapeHtml(result.classificationReason) + '</div></td>',
          '<td><div class="row-title">' + escapeHtml(String(result.attemptCount)) + '</div><div class="row-subtitle">' + escapeHtml(String(result.executionMs)) + ' ms</div></td>',
          '<td><div class="summary-box">' + escapeHtml(result.responseSummary) + '</div></td>',
          '<td>' + suggestions + '</td>',
          '</tr>'
        ].join("");
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }
    </script>
  </body>
</html>`;
}

function renderSummaryCard(label: string, value: number, className = label): string {
  return `
    <article class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value ${escapeHtml(className)}">${value}</div>
    </article>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
