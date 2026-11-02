import { getCases } from "./fhir.js";

const WORKLIST_ID = "worklist-root";
const VIEWER_NAV_ID = "viewer-nav";
const FEEDBACK_STORAGE_KEY =
  "oncomets-ai-feedback-v1";

function readFeedbackStore() {
  try {
    return JSON.parse(
      localStorage.getItem(FEEDBACK_STORAGE_KEY) ??
      "{}"
    );
  } catch {
    return {};
  }
}

function getSavedFeedback(caseId) {
  const store = readFeedbackStore();
  return store[caseId] ?? null;
}

function saveFeedback(caseId, feedback) {
  const store = readFeedbackStore();

  store[caseId] = {
    ...feedback,
    caseId,
    updatedAt: new Date().toISOString(),
  };

  localStorage.setItem(
    FEEDBACK_STORAGE_KEY,
    JSON.stringify(store)
  );

  return store[caseId];
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatStatus(value) {
  const labels = {
    final: "Final",
    preliminary: "Preliminar",
    registered: "Registrado",
    partial: "Parcial",
    amended: "Corregido",
    corrected: "Corregido",
    cancelled: "Cancelado",
    unknown: "Desconocido",
  };

  return labels[value] ?? value ?? "—";
}

function formatTissue(value) {
  if (!value || value === "No especificado") {
    return "—";
  }

  // Primera normalización útil para el dataset actual.
  if (value === "Breast structure") {
    return "Mama";
  }

  return value;
}

function getSearchText(item) {
  return [
    item.caseId,
    item.patient,
    item.tissue,
    item.status,
    item.diagnosis,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function buildOptions(values, emptyLabel) {
  const unique = [
    ...new Set(
      values
        .filter(Boolean)
        .filter(
          (value) =>
            value !== "No especificado"
        )
    ),
  ].sort((a, b) =>
    String(a).localeCompare(String(b), "es")
  );

  return [
    `<option value="">${emptyLabel}</option>`,
    ...unique.map(
      (value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(
          value
        )}</option>`
    ),
  ].join("");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getLegacyPocHeader() {
  const element = Array.from(
    document.querySelectorAll("body *")
  ).find(
    (item) =>
      item.textContent?.trim() ===
      "OncoMETS - WSI Streaming POC"
  );

  if (!element) {
    return null;
  }

  return (
    element.closest("header") ??
    element.parentElement ??
    element
  );
}

function hideViewer() {
  const status =
    document.getElementById("status");

  const viewport =
    document.getElementById("viewport");

  const legacyHeader =
    getLegacyPocHeader();

  if (status) status.hidden = true;
  if (viewport) viewport.hidden = true;
  if (legacyHeader) legacyHeader.hidden = true;

  document
    .getElementById(VIEWER_NAV_ID)
    ?.remove();
}

function showViewer() {
  const status =
    document.getElementById("status");

  const viewport =
    document.getElementById("viewport");

  const legacyHeader =
    getLegacyPocHeader();

  if (status) status.hidden = false;
  if (viewport) viewport.hidden = false;
  if (legacyHeader) legacyHeader.hidden = false;

  document
    .getElementById(WORKLIST_ID)
    ?.remove();
}

function openCase(caseId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("caseId", caseId);
  window.location.href = url.toString();
}

export function prepareViewerMode(caseId) {
  showViewer();

  if (document.getElementById(VIEWER_NAV_ID)) {
    return;
  }

  const nav = document.createElement("div");
  nav.id = VIEWER_NAV_ID;
  nav.className = "viewer-nav";

  nav.innerHTML = `
    <button
      type="button"
      class="viewer-nav__back"
      id="viewer-back-button"
    >
      ← Casos
    </button>
    <div class="viewer-nav__case">
      <span class="viewer-nav__label">Caso</span>
      <strong>${escapeHtml(caseId)}</strong>
    </div>
  `;

  const status =
    document.getElementById("status");

  if (status?.parentNode) {
    status.parentNode.insertBefore(
      nav,
      status
    );
  } else {
    document.body.prepend(nav);
  }

  document
    .getElementById("viewer-back-button")
    ?.addEventListener("click", () => {
      const url = new URL(window.location.href);
      url.search = "";
      window.location.href = url.toString();
    });
}

export async function renderWorklist() {
  hideViewer();

  document
    .getElementById(WORKLIST_ID)
    ?.remove();

  const root = document.createElement("main");
  root.id = WORKLIST_ID;
  root.className = "worklist";

  root.innerHTML = `
    <header class="worklist__header">
      <div>
        <p class="worklist__eyebrow">OncoMETS · Patología digital</p>
        <h1>Casos</h1>
        <p class="worklist__subtitle">
          Seleccione un caso para revisar su información y abrir la WSI.
        </p>
      </div>
      <div class="worklist__summary" id="worklist-summary">
        Cargando casos…
      </div>
    </header>

    <section class="worklist__filters" aria-label="Filtros de casos">
      <label class="worklist__search">
        <span>Buscar</span>
        <input
          id="worklist-search"
          type="search"
          placeholder="ID de caso, resultado IA o tejido"
          autocomplete="off"
        />
      </label>

      <label>
        <span>Tejido</span>
        <select id="worklist-tissue">
          <option value="">Todos</option>
        </select>
      </label>

      <label>
        <span>Estado</span>
        <select id="worklist-status">
          <option value="">Todos</option>
        </select>
      </label>
    </section>

    <div class="worklist__layout">
      <section class="worklist__table-card">
        <div class="worklist__table-scroll">
          <table class="worklist__table">
            <thead>
              <tr>
                <th>Caso</th>
                <th>Fecha</th>
                <th>Tejido</th>
                <th>Estado</th>
                <th>Resultado IA</th>
              </tr>
            </thead>
            <tbody id="worklist-body">
              <tr>
                <td colspan="5" class="worklist__empty">
                  Cargando casos…
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <aside
        class="case-panel"
        id="case-panel"
        aria-live="polite"
      >
        <div class="case-panel__empty">
          <span class="case-panel__icon">WSI</span>
          <h2>Seleccione un caso</h2>
          <p>
            La información del caso aparecerá aquí antes de abrir el visor.
          </p>
        </div>
      </aside>
    </div>
  `;

  document.body.prepend(root);

  const cases = await getCases();

  const searchInput =
    document.getElementById(
      "worklist-search"
    );
  const tissueSelect =
    document.getElementById(
      "worklist-tissue"
    );
  const statusSelect =
    document.getElementById(
      "worklist-status"
    );
  const body =
    document.getElementById("worklist-body");
  const panel =
    document.getElementById("case-panel");
  const summary =
    document.getElementById(
      "worklist-summary"
    );

  tissueSelect.innerHTML = buildOptions(
    cases.map((item) => item.tissue),
    "Todos"
  );

  statusSelect.innerHTML = buildOptions(
    cases.map((item) => item.status),
    "Todos"
  );

  let selectedKey = null;

  function caseKey(item) {
    return `${item.caseId}::${item.imagingStudyReference}`;
  }

  function renderPanel(item) {
    if (!item) {
      panel.innerHTML = `
        <div class="case-panel__empty">
          <span class="case-panel__icon">WSI</span>
          <h2>Seleccione un caso</h2>
          <p>
            La información del caso aparecerá aquí antes de abrir el visor.
          </p>
        </div>
      `;
      return;
    }

    panel.innerHTML = `
      <div class="case-panel__content">
        <div class="case-panel__heading">
          <div>
            <span class="case-panel__kicker">Caso seleccionado</span>
            <h2>${escapeHtml(item.caseId)}</h2>
          </div>
          <span class="case-panel__status">
            ${escapeHtml(formatStatus(item.status))}
          </span>
        </div>

        <dl class="case-panel__facts">
          <div>
            <dt>Fecha</dt>
            <dd>${escapeHtml(formatDate(item.date))}</dd>
          </div>
          <div>
            <dt>Tejido</dt>
            <dd>${escapeHtml(formatTissue(item.tissue))}</dd>
          </div>
          <div>
            <dt>Imagen</dt>
            <dd>WSI disponible</dd>
          </div>
        </dl>

        <div class="case-panel__diagnosis">
          <span>Resultado IA</span>
          <p>${escapeHtml(item.diagnosis)}</p>
        </div>

        <section class="feedback-card">
          <div class="feedback-card__header">
            <div>
              <span class="feedback-card__eyebrow">
                Evaluación del patólogo
              </span>
              <h3>Validación del resultado IA</h3>
            </div>
            <span
              class="feedback-card__saved"
              id="feedback-saved-indicator"
              hidden
            >
              Guardado
            </span>
          </div>

          <fieldset class="feedback-card__agreement">
            <legend>Evaluación del resultado IA</legend>

            <label>
              <input
                type="radio"
                name="ai-agreement"
                value="agree"
              />
              <span>De acuerdo</span>
            </label>

            <label>
              <input
                type="radio"
                name="ai-agreement"
                value="partial"
              />
              <span>Parcialmente de acuerdo</span>
            </label>

            <label>
              <input
                type="radio"
                name="ai-agreement"
                value="disagree"
              />
              <span>En desacuerdo</span>
            </label>
          </fieldset>

          <label class="feedback-card__field">
            <span>Corrección / diagnóstico propuesto</span>
            <textarea
              id="feedback-correction"
              rows="3"
              placeholder="Opcional"
            ></textarea>
          </label>

          <label class="feedback-card__field">
            <span>Comentario</span>
            <textarea
              id="feedback-comment"
              rows="3"
              placeholder="Observaciones del patólogo"
            ></textarea>
          </label>

          <p class="feedback-card__notice">
            Este feedback se guarda localmente en este navegador.
            No modifica el resultado IA ni FHIR.
          </p>

          <button
            type="button"
            class="feedback-card__save"
            id="feedback-save"
          >
            Guardar feedback
          </button>
        </section>

        <button
          type="button"
          class="case-panel__open"
          id="case-open-viewer"
        >
          Abrir visor WSI
        </button>
      </div>
    `;

    const savedFeedback =
      getSavedFeedback(item.caseId);

    if (savedFeedback) {
      const agreementInput =
        document.querySelector(
          `input[name="ai-agreement"][value="${savedFeedback.agreement}"]`
        );

      if (agreementInput) {
        agreementInput.checked = true;
      }

      const correction =
        document.getElementById(
          "feedback-correction"
        );
      const comment =
        document.getElementById(
          "feedback-comment"
        );
      const indicator =
        document.getElementById(
          "feedback-saved-indicator"
        );

      if (correction) {
        correction.value =
          savedFeedback.correctedDiagnosis ?? "";
      }

      if (comment) {
        comment.value =
          savedFeedback.comment ?? "";
      }

      if (indicator) {
        indicator.hidden = false;
      }
    }

    document
      .getElementById("feedback-save")
      ?.addEventListener("click", () => {
        const agreement =
          document.querySelector(
            'input[name="ai-agreement"]:checked'
          )?.value ?? "";

        const correctedDiagnosis =
          document.getElementById(
            "feedback-correction"
          )?.value.trim() ?? "";

        const comment =
          document.getElementById(
            "feedback-comment"
          )?.value.trim() ?? "";

        if (!agreement) {
          window.alert(
            "Selecciona el nivel de acuerdo antes de guardar."
          );
          return;
        }

        saveFeedback(item.caseId, {
          aiResult: item.diagnosis,
          agreement,
          correctedDiagnosis,
          comment,
        });

        const indicator =
          document.getElementById(
            "feedback-saved-indicator"
          );

        if (indicator) {
          indicator.hidden = false;
          indicator.textContent = "Guardado";
        }
      });

    document
      .getElementById("case-open-viewer")
      ?.addEventListener(
        "click",
        () => openCase(item.caseId)
      );
  }

  function renderRows(items) {
    summary.textContent =
      `${items.length} de ${cases.length} ` +
      `${cases.length === 1 ? "caso" : "casos"}`;

    if (items.length === 0) {
      body.innerHTML = `
        <tr>
          <td colspan="5" class="worklist__empty">
            No hay casos que coincidan con los filtros.
          </td>
        </tr>
      `;

      selectedKey = null;
      renderPanel(null);
      return;
    }

    body.innerHTML = items
      .map((item) => {
        const key = caseKey(item);
        const selected =
          key === selectedKey;

        return `
          <tr
            class="${selected ? "is-selected" : ""}"
            data-case-key="${escapeHtml(key)}"
            tabindex="0"
          >
            <td class="worklist__case-id">
              ${escapeHtml(item.caseId)}
            </td>
            <td>${escapeHtml(formatDate(item.date))}</td>
            <td>${escapeHtml(formatTissue(item.tissue))}</td>
            <td>
              <span class="worklist__badge">
                ${escapeHtml(formatStatus(item.status))}
              </span>
            </td>
            <td
              class="worklist__diagnosis"
              title="${escapeHtml(item.diagnosis)}"
            >
              ${escapeHtml(item.diagnosis)}
            </td>
          </tr>
        `;
      })
      .join("");

    body
      .querySelectorAll("tr[data-case-key]")
      .forEach((row) => {
        const selectRow = () => {
          const key =
            row.dataset.caseKey;
          const item =
            cases.find(
              (candidate) =>
                caseKey(candidate) === key
            );

          if (!item) return;

          selectedKey = key;
          renderRows(getFilteredCases());
          renderPanel(item);
        };

        row.addEventListener(
          "click",
          selectRow
        );

        row.addEventListener(
          "keydown",
          (event) => {
            if (
              event.key === "Enter" ||
              event.key === " "
            ) {
              event.preventDefault();
              selectRow();
            }
          }
        );
      });
  }

  function getFilteredCases() {
    const query =
      searchInput.value
        .trim()
        .toLowerCase();
    const tissue =
      tissueSelect.value;
    const status =
      statusSelect.value;

    return cases.filter((item) => {
      const matchesSearch =
        !query ||
        getSearchText(item).includes(query);

      const matchesTissue =
        !tissue ||
        item.tissue === tissue;

      const matchesStatus =
        !status ||
        item.status === status;

      return (
        matchesSearch &&
        matchesTissue &&
        matchesStatus
      );
    });
  }

  function update() {
    renderRows(getFilteredCases());
  }

  searchInput.addEventListener(
    "input",
    update
  );
  tissueSelect.addEventListener(
    "change",
    update
  );
  statusSelect.addEventListener(
    "change",
    update
  );

  renderRows(cases);
}
