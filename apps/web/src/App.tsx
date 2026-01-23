import React from "react";
import { getInitialLocale, persistLocale, t, type I18nVars, type Locale, type MessageKey } from "./i18n";

// --- Types ---
type OrchestratorHealth = { ok: boolean; service?: string };
type ToolserverHealth = { ok: boolean; service: string; ffmpeg: boolean; data_dir: string; db_path: string };
type OrchestratorConfig = { ok: boolean; default_model: string; base_url: string };

type ClientConfig = {
  base_url?: string;
  gemini_api_key?: string;
  exa_api_key?: string;
  default_model?: string;
};

type Project = { id: string; title: string; created_at_ms: number };
type Consent = { project_id: string; consented: boolean; auto_confirm: boolean; updated_at_ms: number };
type ProjectSettings = { project_id: string; think_enabled: boolean; updated_at_ms: number };
type Artifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ImportLocalResponse = { artifact: Artifact; bytes: number; file_name: string };
type PoolItem = {
  id: string;
  project_id: string;
  kind: string;
  title: string | null;
  source_url: string | null;
  license: string | null;
  dedup_key: string;
  data_json: string | null;
  selected: boolean;
  created_at_ms: number;
};

const CLIENT_CONFIG_KEY = "vidunpack_client_config_v1";

function normalizeClientConfig(cfg: ClientConfig): ClientConfig {
  const out: ClientConfig = {};
  const baseUrl = cfg.base_url?.trim();
  const geminiKey = cfg.gemini_api_key?.trim();
  const exaKey = cfg.exa_api_key?.trim();
  const defaultModel = cfg.default_model?.trim();

  if (baseUrl) out.base_url = baseUrl;
  if (geminiKey) out.gemini_api_key = geminiKey;
  if (exaKey) out.exa_api_key = exaKey;
  if (defaultModel) out.default_model = defaultModel;

  return out;
}

function loadClientConfig(): ClientConfig {
  try {
    const raw = localStorage.getItem(CLIENT_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    return normalizeClientConfig({
      base_url: typeof obj.base_url === "string" ? obj.base_url : undefined,
      gemini_api_key: typeof obj.gemini_api_key === "string" ? obj.gemini_api_key : undefined,
      exa_api_key: typeof obj.exa_api_key === "string" ? obj.exa_api_key : undefined,
      default_model: typeof obj.default_model === "string" ? obj.default_model : undefined,
    });
  } catch {
    return {};
  }
}

function saveClientConfig(cfg: ClientConfig) {
  try {
    localStorage.setItem(CLIENT_CONFIG_KEY, JSON.stringify(normalizeClientConfig(cfg)));
  } catch {
    // ignore
  }
}

// --- API Helpers ---
async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  if (!res.ok) {
    try {
      const parsed = JSON.parse(text) as { error?: string };
      throw new Error(parsed.error || `HTTP ${res.status}`);
    } catch {
      throw new Error(text || `HTTP ${res.status}`);
    }
  }
  return JSON.parse(text) as T;
}

async function postJson<T>(input: string, body: unknown): Promise<T> {
  return fetchJson<T>(input, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function formatTs(ms: number) {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? String(ms) : d.toLocaleString(undefined, {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function bytesToSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- Components ---

const Header = ({
  locale,
  toggleLocale,
  onOpenSettings,
  orchHealth,
  toolHealth,
  healthError,
  tr,
}: {
  locale: Locale;
  toggleLocale: () => void;
  onOpenSettings: () => void;
  orchHealth: OrchestratorHealth | null;
  toolHealth: ToolserverHealth | null;
  healthError: string | null;
  tr: (k: MessageKey, v?: I18nVars) => string;
}) => (
  <header className="app-header">
    <div className="width-constraint header-inner">
      <div className="brand">
        <div className="brand-title">{tr("appTitle")}</div>
        <div className="brand-subtitle">{tr("appSubtitle")}</div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex gap-2 items-center" title="System Health">
          {healthError ? (
            <span className="text-error text-xs font-medium">{tr("systemError")}</span>
          ) : (
            <>
              <div className={`status-dot ${orchHealth?.ok ? "ok" : "err"}`} title={tr("orchestrator")} />
              <div className={`status-dot ${toolHealth?.ok ? "ok" : "err"}`} title={tr("toolserver")} />
            </>
          )}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onOpenSettings} type="button">
          {tr("settings")}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={toggleLocale} data-testid="lang-toggle">
          {locale === "en" ? tr("langZH") : tr("langEN")}
        </button>
      </div>
    </div>
  </header>
);

const ProjectList = ({
  projects,
  loading,
  error,
  createBusy,
  createTitle,
  setCreateTitle,
  onCreate,
  onOpen,
  onRefresh,
  onOpenSettings,
  tr,
}: {
  projects: Project[];
  loading: boolean;
  error: string | null;
  createBusy: boolean;
  createTitle: string;
  setCreateTitle: (s: string) => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  tr: (k: MessageKey) => string;
}) => (
  <div className="panel animate-enter">
    <div className="panel-header">
      <div className="panel-title">{tr("projects")}</div>
      <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading} data-testid="refresh-projects">
        {tr("refresh")}
      </button>
    </div>

    <div className="flex gap-2 mb-6">
      <input
        type="text"
        placeholder={tr("newProjectTitlePlaceholder")}
        value={createTitle}
        onChange={(e) => setCreateTitle(e.target.value)}
        disabled={createBusy}
        data-testid="create-project-input"
        className="flex-1"
      />
      <button className="btn btn-primary" onClick={onCreate} disabled={createBusy} data-testid="create-project-btn">
        {createBusy ? tr("creating") : tr("createProject")}
      </button>
    </div>

    {error && <div className="alert mb-4">{error}</div>}

    {loading && projects.length === 0 ? (
      <div className="text-center text-muted py-8">{tr("loadingProjects")}</div>
    ) : projects.length === 0 ? (
      <div className="text-center text-muted py-8">
        <div className="mb-4">{tr("emptyProjects")}</div>
        <div className="onboarding">
          <div className="text-sm font-bold text-main mb-2">{tr("quickStartTitle")}</div>
          <ol className="onboarding-list text-sm text-muted">
            <li>{tr("quickStartStep1")}</li>
            <li>{tr("quickStartStep2")}</li>
            <li>{tr("quickStartStep3")}</li>
            <li>{tr("quickStartStep4")}</li>
          </ol>
          <div className="mt-4 flex justify-center">
            <button className="btn btn-secondary btn-sm" type="button" onClick={onOpenSettings}>
              {tr("openSettings")}
            </button>
          </div>
        </div>
      </div>
    ) : (
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{tr("title")}</th>
              <th>{tr("created")}</th>
              <th className="text-right">{tr("action")}</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td className="font-medium text-main">{p.title || tr("untitled")}</td>
                <td className="mono text-xs text-muted">{formatTs(p.created_at_ms)}</td>
                <td className="text-right">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onOpen(p.id)}
                    data-testid={`open-project-${p.id}`}
                  >
                    {tr("open")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

// --- Main App ---

type View =
  | { kind: "list" }
  | { kind: "settings" }
  | { kind: "project"; projectId: string };

export default function App() {
  const [locale, setLocale] = React.useState<Locale>(() => getInitialLocale());
  const tr = React.useCallback((key: MessageKey, vars?: I18nVars) => t(locale, key, vars), [locale]);

  React.useEffect(() => {
    persistLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const toggleLocale = React.useCallback(() => {
    setLocale((prev) => (prev === "en" ? "zh-CN" : "en"));
  }, []);

  const [orchHealth, setOrchHealth] = React.useState<OrchestratorHealth | null>(null);
  const [toolHealth, setToolHealth] = React.useState<ToolserverHealth | null>(null);
  const [healthError, setHealthError] = React.useState<string | null>(null);

  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectsError, setProjectsError] = React.useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = React.useState(false);

  const [createTitle, setCreateTitle] = React.useState("");
  const [createBusy, setCreateBusy] = React.useState(false);

  const [view, setView] = React.useState<View>({ kind: "list" });
  const returnFromSettings = React.useRef<View>({ kind: "list" });

  const [clientConfig, setClientConfig] = React.useState<ClientConfig>(() => loadClientConfig());
  const [orchConfig, setOrchConfig] = React.useState<OrchestratorConfig | null>(null);

  const [settingsDraft, setSettingsDraft] = React.useState(() => {
    const cfg = loadClientConfig();
    return {
      base_url: cfg.base_url ?? "",
      gemini_api_key: cfg.gemini_api_key ?? "",
      exa_api_key: cfg.exa_api_key ?? "",
      default_model: cfg.default_model ?? "",
    };
  });
  const [settingsSavedAt, setSettingsSavedAt] = React.useState<number | null>(null);

  const [project, setProject] = React.useState<Project | null>(null);
  const [consent, setConsent] = React.useState<Consent | null>(null);
  const [settings, setSettings] = React.useState<ProjectSettings | null>(null);
  const [artifacts, setArtifacts] = React.useState<Artifact[]>([]);
  const [poolItems, setPoolItems] = React.useState<PoolItem[]>([]);
  const [projectError, setProjectError] = React.useState<string | null>(null);
  const [projectLoading, setProjectLoading] = React.useState(false);

  const [localFile, setLocalFile] = React.useState<File | null>(null);
  const [importBusy, setImportBusy] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);

  const [inputUrl, setInputUrl] = React.useState("");
  const [saveUrlBusy, setSaveUrlBusy] = React.useState(false);
  const [saveUrlError, setSaveUrlError] = React.useState<string | null>(null);

  const [analysisModel, setAnalysisModel] = React.useState(() => clientConfig.default_model ?? "gemini-3-preview");
  const [analysisVideoArtifactId, setAnalysisVideoArtifactId] = React.useState<string>("");
  const [analysisBusy, setAnalysisBusy] = React.useState(false);
  const [analysisError, setAnalysisError] = React.useState<string | null>(null);
  const [analysisText, setAnalysisText] = React.useState<string | null>(null);
  const [analysisParsed, setAnalysisParsed] = React.useState<unknown | null>(null);
  const [analysisArtifact, setAnalysisArtifact] = React.useState<Artifact | null>(null);

  const [lastPlan, setLastPlan] = React.useState<unknown | null>(null);
  const [lastPlanArtifact, setLastPlanArtifact] = React.useState<Artifact | null>(null);

  const [exaQuery, setExaQuery] = React.useState("");
  const [exaBusy, setExaBusy] = React.useState(false);
  const [exaError, setExaError] = React.useState<string | null>(null);
  const [exaRound, setExaRound] = React.useState<number | null>(null);
  const [exaResults, setExaResults] = React.useState<Array<{ title?: string; url?: string }>>([]);

  const [fetchBusy, setFetchBusy] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [fetchUrl, setFetchUrl] = React.useState<string | null>(null);
  const [fetchRaw, setFetchRaw] = React.useState<unknown | null>(null);

  const [reportBusy, setReportBusy] = React.useState(false);
  const [reportError, setReportError] = React.useState<string | null>(null);
  const [reportOut, setReportOut] = React.useState<{ report_html: Artifact; manifest_json: Artifact } | null>(null);

  const [zipIncludeVideo, setZipIncludeVideo] = React.useState(true);
  const [zipEstimateBusy, setZipEstimateBusy] = React.useState(false);
  const [zipEstimateError, setZipEstimateError] = React.useState<string | null>(null);
  const [zipEstimate, setZipEstimate] = React.useState<
    | {
        total_bytes: number;
        files: Array<{ name: string; bytes: number }>;
      }
    | null
  >(null);

  const [zipExportBusy, setZipExportBusy] = React.useState(false);
  const [zipExportError, setZipExportError] = React.useState<string | null>(null);
  const [zipExport, setZipExport] = React.useState<{ zip: Artifact; total_bytes: number; download_url: string } | null>(null);

  const [consentModalOpen, setConsentModalOpen] = React.useState(false);
  const [consentModalAutoConfirm, setConsentModalAutoConfirm] = React.useState(true);
  const [consentModalUrl, setConsentModalUrl] = React.useState<string | null>(null);
  const [consentModalBusy, setConsentModalBusy] = React.useState(false);
  const [consentModalError, setConsentModalError] = React.useState<string | null>(null);

  const refreshHealth = React.useCallback(async () => {
    setHealthError(null);
    try {
      const [o, t] = await Promise.all([
        fetchJson<OrchestratorHealth>("/api/health"),
        fetchJson<ToolserverHealth>("/tool/health"),
      ]);
      setOrchHealth(o);
      setToolHealth(t);
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshProjects = React.useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const list = await fetchJson<Project[]>("/tool/projects");
      setProjects(list);
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const refreshProject = React.useCallback(async (projectId: string) => {
    setProjectLoading(true);
    setProjectError(null);
    try {
      const [p, c, s, a, pool] = await Promise.all([
        fetchJson<Project>(`/tool/projects/${projectId}`),
        fetchJson<Consent>(`/tool/projects/${projectId}/consent`),
        fetchJson<ProjectSettings>(`/tool/projects/${projectId}/settings`),
        fetchJson<Artifact[]>(`/tool/projects/${projectId}/artifacts`),
        fetchJson<PoolItem[]>(`/tool/projects/${projectId}/pool/items`),
      ]);
      setProject(p);
      setConsent(c);
      setSettings(s);
      setArtifacts(a);
      setPoolItems(pool);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshHealth();
    void refreshProjects();
  }, [refreshHealth, refreshProjects]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchJson<OrchestratorConfig>("/api/config");
        if (cancelled) return;
        setOrchConfig(cfg);
        if (!clientConfig.default_model && cfg?.default_model) setAnalysisModel(cfg.default_model);
      } catch {
        // ignore config errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientConfig.default_model]);

  React.useEffect(() => {
    if (view.kind !== "project") return;
    void refreshProject(view.projectId);
  }, [refreshProject, view]);

  const onCreateProject = async () => {
    setCreateBusy(true);
    setProjectsError(null);
    try {
      const created = await postJson<Project>("/tool/projects", { title: createTitle.trim() || undefined });
      setCreateTitle("");
      await refreshProjects();
      setView({ kind: "project", projectId: created.id });
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const onOpenProject = (projectId: string) => {
    setView({ kind: "project", projectId });
  };

  const onOpenSettings = () => {
    returnFromSettings.current = view.kind === "settings" ? { kind: "list" } : view;
    setSettingsDraft({
      base_url: clientConfig.base_url ?? "",
      gemini_api_key: clientConfig.gemini_api_key ?? "",
      exa_api_key: clientConfig.exa_api_key ?? "",
      default_model: clientConfig.default_model ?? "",
    });
    setSettingsSavedAt(null);
    setView({ kind: "settings" });
  };

  const onCloseSettings = () => {
    const next = returnFromSettings.current;
    setView(next.kind === "settings" ? { kind: "list" } : next);
  };

  const onSaveSettings = () => {
    const next = normalizeClientConfig({
      base_url: settingsDraft.base_url,
      gemini_api_key: settingsDraft.gemini_api_key,
      exa_api_key: settingsDraft.exa_api_key,
      default_model: settingsDraft.default_model,
    });
    saveClientConfig(next);
    setClientConfig(next);
    if (next.default_model) setAnalysisModel(next.default_model);
    setSettingsSavedAt(Date.now());
  };

  const onClearSettings = () => {
    saveClientConfig({});
    setClientConfig({});
    setSettingsDraft({ base_url: "", gemini_api_key: "", exa_api_key: "", default_model: "" });
    setSettingsSavedAt(Date.now());
    setAnalysisModel(orchConfig?.default_model ?? "gemini-3-preview");
  };

  const onBackToList = () => {
    setProject(null);
    setConsent(null);
    setSettings(null);
    setArtifacts([]);
    setPoolItems([]);
    setProjectError(null);
    setLocalFile(null);
    setImportError(null);
    setInputUrl("");
    setSaveUrlError(null);
    setLastPlan(null);
    setLastPlanArtifact(null);
    setView({ kind: "list" });
  };

  const onToggleAutoConfirm = async (next: boolean) => {
    if (view.kind !== "project") return;
    try {
      const updated = await postJson<Consent>(`/tool/projects/${view.projectId}/consent`, { auto_confirm: next });
      setConsent(updated);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggleThink = async (next: boolean) => {
    if (view.kind !== "project") return;
    try {
      const updated = await postJson<ProjectSettings>(`/tool/projects/${view.projectId}/settings`, { think_enabled: next });
      setSettings(updated);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    }
  };

  const onImportLocal = async () => {
    if (view.kind !== "project") return;
    if (!localFile) return;

    setImportBusy(true);
    setImportError(null);
    try {
      const form = new FormData();
      form.append("file", localFile);
      const res = await fetch(`/tool/projects/${view.projectId}/media/local`, {
        method: "POST",
        body: form,
      });
      const text = await res.text();
      if (!res.ok) {
        try {
          const parsed = JSON.parse(text) as { error?: string };
          throw new Error(parsed.error || `HTTP ${res.status}`);
        } catch {
          throw new Error(text || `HTTP ${res.status}`);
        }
      }
      const json = JSON.parse(text) as ImportLocalResponse;
      setLocalFile(null);
      setArtifacts((prev) => [json.artifact, ...prev]);
      await refreshProject(view.projectId);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  };

  const onSaveUrl = async () => {
    if (view.kind !== "project") return;
    setSaveUrlError(null);
    const url = inputUrl.trim();
    if (!url) {
      setSaveUrlError(tr("errEnterUrl"));
      return;
    }

    if (!consent?.consented) {
      setConsentModalUrl(url);
      setConsentModalOpen(true);
      return;
    }

    setSaveUrlBusy(true);
    try {
      await postJson<Artifact>(`/tool/projects/${view.projectId}/inputs/url`, { url });
      setInputUrl("");
      await refreshProject(view.projectId);
    } catch (e) {
      setSaveUrlError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaveUrlBusy(false);
    }
  };

  const onRunAnalysis = async () => {
    if (view.kind !== "project") return;
    setAnalysisError(null);
    setAnalysisText(null);
    setAnalysisParsed(null);
    setAnalysisArtifact(null);
    setLastPlan(null);
    setLastPlanArtifact(null);

    const model = analysisModel.trim();
    if (!model) {
      setAnalysisError(tr("errEnterModel"));
      return;
    }
    if (!analysisVideoArtifactId) {
      setAnalysisError(tr("errPickLocalVideo"));
      return;
    }

    setAnalysisBusy(true);
    try {
      const resp = await postJson<{
        ok: boolean;
        plan: unknown | null;
        plan_artifact?: Artifact | null;
        model: string;
        artifact: Artifact;
        text: string;
        parsed: unknown | null;
      }>(`/api/projects/${view.projectId}/gemini/analyze`, {
        model,
        input_video_artifact_id: analysisVideoArtifactId,
        base_url: clientConfig.base_url,
        gemini_api_key: clientConfig.gemini_api_key,
      });

      setAnalysisText(resp.text || "");
      setAnalysisParsed(resp.parsed ?? null);
      setAnalysisArtifact(resp.artifact);
      setLastPlan(resp.plan ?? null);
      setLastPlanArtifact(resp.plan_artifact ?? null);
      await refreshProject(view.projectId);
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalysisBusy(false);
    }
  };

  const onExaSearch = async () => {
    if (view.kind !== "project") return;
    setExaError(null);
    setFetchError(null);
    setFetchUrl(null);
    setFetchRaw(null);

    const query = exaQuery.trim();
    if (!query) {
      setExaError(tr("errEnterSearchQuery"));
      return;
    }

    setExaBusy(true);
    try {
      const resp = await postJson<{
        ok: boolean;
        plan: unknown | null;
        plan_artifact?: Artifact | null;
        round: number;
        query: string;
        results: Array<{ title?: string; url?: string }>;
      }>(`/api/projects/${view.projectId}/exa/search`, { query, exa_api_key: clientConfig.exa_api_key });
      setExaRound(resp.round);
      setExaResults(resp.results || []);
      setLastPlan(resp.plan ?? null);
      setLastPlanArtifact(resp.plan_artifact ?? null);
      await refreshProject(view.projectId);
    } catch (e) {
      setExaError(e instanceof Error ? e.message : String(e));
    } finally {
      setExaBusy(false);
    }
  };

  const onWebFetch = async (url: string) => {
    if (view.kind !== "project") return;
    setFetchError(null);
    setFetchUrl(url);
    setFetchRaw(null);

    setFetchBusy(true);
    try {
      const resp = await postJson<{ ok: boolean; plan: unknown | null; plan_artifact?: Artifact | null; url: string; raw: unknown }>(
        `/api/projects/${view.projectId}/exa/fetch`,
        { url, exa_api_key: clientConfig.exa_api_key },
      );
      setFetchRaw(resp.raw);
      setLastPlan(resp.plan ?? null);
      setLastPlanArtifact(resp.plan_artifact ?? null);
      await refreshProject(view.projectId);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchBusy(false);
    }
  };

  const onAddToPool = async (url: string, title?: string) => {
    if (view.kind !== "project") return;
    try {
      await postJson<PoolItem>(`/tool/projects/${view.projectId}/pool/items`, {
        kind: "link",
        title: title || undefined,
        source_url: url,
        data: { url, title },
      });
      await refreshProject(view.projectId);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    }
  };

  const onTogglePoolSelected = async (itemId: string, selected: boolean) => {
    if (view.kind !== "project") return;
    try {
      await postJson<PoolItem>(`/tool/projects/${view.projectId}/pool/items/${itemId}/selected`, { selected });
      await refreshProject(view.projectId);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    }
  };

  const onGenerateReport = async () => {
    if (view.kind !== "project") return;
    setReportError(null);
    setReportOut(null);
    setReportBusy(true);
    try {
      const resp = await fetchJson<{ report_html: Artifact; manifest_json: Artifact }>(`/tool/projects/${view.projectId}/exports/report`, {
        method: "POST",
      });
      setReportOut(resp);
      await refreshProject(view.projectId);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportBusy(false);
    }
  };

  const onEstimateZip = async () => {
    if (view.kind !== "project") return;
    setZipEstimateError(null);
    setZipEstimate(null);
    setZipEstimateBusy(true);
    try {
      const resp = await postJson<{ total_bytes: number; files: Array<{ name: string; bytes: number }> }>(
        `/tool/projects/${view.projectId}/exports/zip/estimate`,
        { include_original_video: zipIncludeVideo, include_report: true, include_manifest: true },
      );
      setZipEstimate(resp);
    } catch (e) {
      setZipEstimateError(e instanceof Error ? e.message : String(e));
    } finally {
      setZipEstimateBusy(false);
    }
  };

  const onExportZip = async () => {
    if (view.kind !== "project") return;
    setZipExportError(null);
    setZipExport(null);
    setZipExportBusy(true);
    try {
      const resp = await postJson<{ zip: Artifact; total_bytes: number; download_url: string }>(
        `/tool/projects/${view.projectId}/exports/zip`,
        { include_original_video: zipIncludeVideo, include_report: true, include_manifest: true },
      );
      setZipExport(resp);
    } catch (e) {
      setZipExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setZipExportBusy(false);
    }
  };

  const onConfirmConsentAndSaveUrl = async () => {
    if (view.kind !== "project") return;
    if (!consentModalUrl) return;

    setConsentModalBusy(true);
    setConsentModalError(null);
    try {
      const updated = await postJson<Consent>(`/tool/projects/${view.projectId}/consent`, {
        consented: true,
        auto_confirm: consentModalAutoConfirm,
      });
      setConsent(updated);
      await postJson<Artifact>(`/tool/projects/${view.projectId}/inputs/url`, { url: consentModalUrl });
      setInputUrl("");
      setConsentModalOpen(false);
      setConsentModalUrl(null);
      await refreshProject(view.projectId);
    } catch (e) {
      setConsentModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setConsentModalBusy(false);
    }
  };

  const inputVideos = artifacts.filter((a) => a.kind === "input_video");
  const inputUrls = artifacts.filter((a) => a.kind === "input_url");
  const exaSearchCount = artifacts.filter((a) => a.kind === "exa_search").length;
  const webFetchCount = artifacts.filter((a) => a.kind === "web_fetch").length;
  const poolSelectedCount = poolItems.filter((i) => i.selected).length;

  React.useEffect(() => {
    if (view.kind !== "project") return;
    if (inputVideos.length === 0) {
      setAnalysisVideoArtifactId("");
      return;
    }
    if (!analysisVideoArtifactId || !inputVideos.some((v) => v.id === analysisVideoArtifactId)) {
      setAnalysisVideoArtifactId(inputVideos[0].id);
    }
  }, [analysisVideoArtifactId, inputVideos, view.kind]);

  return (
    <div className="app-root">
      <Header
        locale={locale}
        toggleLocale={toggleLocale}
        onOpenSettings={onOpenSettings}
        orchHealth={orchHealth}
        toolHealth={toolHealth}
        healthError={healthError}
        tr={tr}
      />

      <main className="main-content">
        <div className="width-constraint">
          {(healthError || !orchHealth?.ok || !toolHealth?.ok) && (
            <div className="alert mb-6">
              <div className="font-medium">{tr("backendOfflineTitle")}</div>
              <div className="text-sm text-muted mt-1">{tr("backendOfflineDesc")}</div>
              <div className="mono text-sm mt-2">{tr("backendOfflineCommand")} npm run dev</div>
            </div>
          )}

          {view.kind === "list" ? (
            <ProjectList
              projects={projects}
              loading={projectsLoading}
              error={projectsError}
              createBusy={createBusy}
              createTitle={createTitle}
              setCreateTitle={setCreateTitle}
              onCreate={onCreateProject}
              onOpen={onOpenProject}
              onRefresh={refreshProjects}
              onOpenSettings={onOpenSettings}
              tr={tr}
            />
          ) : view.kind === "settings" ? (
            <div className="animate-enter">
              <div className="flex items-center gap-2 mb-6">
                <button className="btn btn-ghost btn-sm" type="button" onClick={onCloseSettings}>
                  &larr; {tr("backToProjects")}
                </button>
                <span className="text-dim">/</span>
                <span className="font-bold text-lg text-main">{tr("globalSettingsTitle")}</span>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div className="panel-title">{tr("globalSettingsTitle")}</div>
                </div>

                <div className="text-sm text-muted mb-6">{tr("globalSettingsHint")}</div>

                <div className="settings-grid">
                  <div className="panel">
                    <div className="panel-header">
                      <div className="panel-title">{tr("settingsGemini")}</div>
                    </div>

                    <div className="input-group">
                      <label className="input-label">{tr("settingsBaseUrl")}</label>
                      <input
                        className="input-field"
                        type="text"
                        placeholder={orchConfig?.base_url ? orchConfig.base_url : "https://generativelanguage.googleapis.com"}
                        value={settingsDraft.base_url}
                        onChange={(e) => setSettingsDraft((p) => ({ ...p, base_url: e.target.value }))}
                      />
                      <div className="text-xs text-dim mt-1">{tr("settingsEmptyUsesEnv")}</div>
                    </div>

                    <div className="input-group">
                      <label className="input-label">{tr("settingsGeminiKey")}</label>
                      <input
                        className="input-field"
                        type="password"
                        placeholder={tr("settingsKeyPlaceholder")}
                        value={settingsDraft.gemini_api_key}
                        onChange={(e) => setSettingsDraft((p) => ({ ...p, gemini_api_key: e.target.value }))}
                      />
                      <div className="text-xs text-dim mt-1">{tr("settingsEmptyUsesEnv")}</div>
                    </div>

                    <div className="input-group">
                      <label className="input-label">{tr("settingsDefaultModel")}</label>
                      <input
                        className="input-field"
                        type="text"
                        placeholder={orchConfig?.default_model ?? "gemini-3-preview"}
                        value={settingsDraft.default_model}
                        onChange={(e) => setSettingsDraft((p) => ({ ...p, default_model: e.target.value }))}
                      />
                      <div className="text-xs text-dim mt-1">{tr("settingsEmptyUsesEnv")}</div>
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <div className="panel-title">{tr("settingsExa")}</div>
                    </div>

                    <div className="input-group">
                      <label className="input-label">{tr("settingsExaKey")}</label>
                      <input
                        className="input-field"
                        type="password"
                        placeholder={tr("settingsKeyPlaceholder")}
                        value={settingsDraft.exa_api_key}
                        onChange={(e) => setSettingsDraft((p) => ({ ...p, exa_api_key: e.target.value }))}
                      />
                      <div className="text-xs text-dim mt-1">{tr("settingsEmptyUsesEnv")}</div>
                    </div>

                    <div className="text-sm text-muted">{tr("settingsExaHint")}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-6">
                  <button className="btn btn-ghost btn-sm" type="button" onClick={onClearSettings}>
                    {tr("clear")}
                  </button>

                  <div className="flex items-center gap-2">
                    {settingsSavedAt && <span className="text-sm text-muted">{tr("saved")}</span>}
                    <button className="btn btn-primary" type="button" onClick={onSaveSettings}>
                      {tr("save")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="animate-enter">
              <div className="flex items-center gap-2 mb-6">
                <button className="btn btn-ghost btn-sm" onClick={onBackToList} data-testid="back-to-list">
                  &larr; {tr("backToProjects")}
                </button>
                <span className="text-dim">/</span>
                <span className="font-bold text-lg text-main">{project?.title || tr("untitled")}</span>
              </div>

              {projectError && <div className="alert mb-6">{projectError}</div>}
              {projectLoading && <div className="text-center text-muted mb-4">{tr("loadingProjectData")}</div>}

              {project && (
                <div className="dashboard-grid">
                  {/* Column 1: Config */}
                  <div className="flex flex-col gap-4">
                    <div className="panel">
                      <div className="panel-header">
                        <div className="panel-title">{tr("colConfig")}</div>
                      </div>

                      {/* Settings */}
                      <div className="mb-6">
                        <div className="text-xs font-bold text-muted uppercase mb-3">{tr("settings")}</div>
                        <div className="flex justify-between items-center mb-3">
                           <span className="text-sm">{tr("autoConfirmDownloads")}</span>
                           <label className="toggle-switch">
                              <input
                                type="checkbox"
                                hidden
                                checked={!!consent?.auto_confirm}
                                onChange={(e) => void onToggleAutoConfirm(e.target.checked)}
                                disabled={!consent?.consented}
                              />
                              <div className="toggle-track"><div className="toggle-knob"/></div>
                           </label>
                        </div>
                        <div className="text-xs text-dim mb-4 flex justify-between">
                           {tr("consent")}: 
                           <span className={consent?.consented ? "text-success" : "text-warn"}>
                              {consent?.consented ? tr("granted") : tr("pending")}
                           </span>
                        </div>

                        <div className="flex justify-between items-center">
                           <span className="text-sm">{tr("enableReasoning")}</span>
                           <label className="toggle-switch">
                              <input
                                type="checkbox"
                                hidden
                                checked={settings?.think_enabled ?? true}
                                onChange={(e) => void onToggleThink(e.target.checked)}
                                data-testid="toggle-think"
                              />
                               <div className="toggle-track"><div className="toggle-knob"/></div>
                           </label>
                        </div>
                      </div>

                      {/* Inputs */}
                      <div>
                        <div className="text-xs font-bold text-muted uppercase mb-3">{tr("inputs")}</div>
                        <div className="input-group">
                           <label className="input-label">{tr("localVideo")}</label>
                           <div className="flex gap-2">
                             <input
                                className="flex-1 input-field"
                                type="file"
                                accept="video/*"
                                onChange={(e) => setLocalFile(e.target.files?.item(0) || null)}
                                disabled={importBusy}
                             />
                             <button className="btn btn-secondary" onClick={onImportLocal} disabled={importBusy || !localFile}>
                               {importBusy ? "…" : tr("import")}
                             </button>
                           </div>
                           {importError && <div className="text-error text-xs mt-1">{importError}</div>}
                        </div>

                        <div className="input-group">
                           <label className="input-label">{tr("videoUrl")}</label>
                           <div className="flex gap-2">
                               <input
                                 type="text"
                                 placeholder="https://..."
                                 value={inputUrl}
                                 onChange={(e) => setInputUrl(e.target.value)}
                                 disabled={saveUrlBusy}
                                 data-testid="input-url"
                                 className="flex-1"
                               />
                               <button
                                 className="btn btn-secondary"
                                 onClick={onSaveUrl}
                                 disabled={saveUrlBusy}
                                 data-testid="save-url"
                               >
                                  {tr("save")}
                               </button>
                            </div>
                            {saveUrlError && <div className="text-error text-xs mt-1">{saveUrlError}</div>}
                         </div>

                        <div className="mt-4 border-t border-base pt-4">
                          <div className="text-xs text-dim mb-2">{tr("videosCount", { count: inputVideos.length })}</div>
                          {inputVideos.map(v => <div key={v.id} className="text-xs mono truncate text-muted mb-1" title={v.path}>• {v.path}</div>)}
                          <div className="text-xs text-dim mt-3 mb-2">{tr("urlsCount", { count: inputUrls.length })}</div>
                          {inputUrls.map(u => <div key={u.id} className="text-xs mono truncate text-muted mb-1" title={u.path}>• {u.path}</div>)}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Column 2: Workspace */}
                  <div className="flex flex-col gap-4">
                    <div className="panel">
                       <div className="panel-header">
                         <div className="panel-title">{tr("colWorkspace")}</div>
                       </div>
                       
                       {/* Analysis */}
                       <div className="mb-8">
                         <div className="text-xs font-bold text-muted uppercase mb-3">{tr("analysis")}</div>
                         <div className="flex gap-2 mb-3">
                            <input
                               className="flex-1 input-field"
                               placeholder={tr("modelIdPlaceholder")}
                               value={analysisModel}
                               onChange={(e) => setAnalysisModel(e.target.value)}
                               disabled={analysisBusy}
                            />
                            <select
                               className="flex-1 input-field"
                               value={analysisVideoArtifactId}
                               onChange={(e) => setAnalysisVideoArtifactId(e.target.value)}
                               disabled={analysisBusy || inputVideos.length === 0}
                            >
                               {inputVideos.length === 0 ? <option value="">{tr("noVideoAvailable")}</option> : inputVideos.map(v => (
                                 <option key={v.id} value={v.id}>{v.path}</option>
                               ))}
                            </select>
                         </div>
                         <button className="btn btn-primary w-full" onClick={() => void onRunAnalysis()} disabled={analysisBusy} data-testid="run-analysis">
                            {analysisBusy ? tr("analyzing") : tr("runAnalysis")}
                         </button>
                         {analysisError && <div className="alert mt-2">{analysisError}</div>}
                         
                         {(analysisText || analysisParsed) ? (
                           <div className="mt-4 code-block">
                              {analysisParsed ? JSON.stringify(analysisParsed, null, 2) : analysisText}
                           </div>
                         ) : (
                           <div className="mt-4 text-center text-muted text-xs py-8 border border-dashed border-base rounded-md">
                             {tr("analysisPlaceholder")}
                           </div>
                         )}

                          {(settings?.think_enabled ?? true) && lastPlan != null && (
                            <div className="mt-4">
                               <div className="text-xs text-muted mb-2">{tr("latestPlan")}</div>
                               <div className="code-block text-xs">{JSON.stringify(lastPlan, null, 2)}</div>
                            </div>
                          )}
                       </div>

                       {/* Search */}
                       <div className="border-t border-base pt-6">
                          <div className="flex justify-between items-center mb-3">
                             <div className="text-xs font-bold text-muted uppercase">{tr("contextSearch")}</div>
                             <div className="text-xs mono text-dim">{tr("usageStats", { exa: exaSearchCount, fetch: webFetchCount })}</div>
                          </div>
                          <div className="flex gap-2 mb-4">
                             <input 
                               type="text"
                               className="flex-1"
                               placeholder={tr("searchQueryPlaceholder")}
                               value={exaQuery}
                               onChange={e => setExaQuery(e.target.value)}
                               disabled={exaBusy || fetchBusy}
                             />
                             <button className="btn btn-secondary" onClick={() => void onExaSearch()} disabled={exaBusy || fetchBusy}>
                                {exaBusy ? tr("searching") : tr("search")}
                             </button>
                          </div>
                          {exaError && <div className="alert mb-2">{exaError}</div>}

                          {exaResults.length > 0 && (
                            <div className="flex flex-col gap-0 border border-base rounded-md overflow-hidden bg-white/50">
                              {exaResults.map((r, i) => (
                                <div key={i} className="p-3 border-b border-base last:border-0 hover:bg-black/5 flex gap-2 justify-between items-center transition-colors">
                                  <div className="flex-1 overflow-hidden">
                                    <div className="text-sm font-medium truncate" title={r.title}>{r.title || tr("untitled")}</div>
                                    <a href={r.url} target="_blank" rel="noopener" className="text-xs mono text-success truncate block mt-1 opacity-80">{r.url}</a>
                                  </div>
                                  <div className="flex gap-2 shrink-0">
                                    <button className="btn btn-secondary btn-sm" onClick={() => r.url && void onWebFetch(r.url)} disabled={!r.url || fetchBusy}>
                                      {tr("fetch")}
                                    </button>
                                    <button className="btn btn-secondary btn-sm" onClick={() => r.url && void onAddToPool(r.url, r.title)} disabled={!r.url}>
                                      {tr("add")}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {fetchUrl && (
                            <div className="mt-4">
                               <div className="text-xs text-muted mb-1">{tr("fetched", { url: fetchUrl })}</div>
                               {fetchError ? <div className="text-error text-xs">{fetchError}</div> : 
                                fetchRaw ? <div className="code-block text-xs h-32">{JSON.stringify(fetchRaw, null, 2)}</div> : null}
                            </div>
                          )}
                       </div>
                    </div>
                  </div>

                  {/* Column 3: Results */}
                  <div className="flex flex-col gap-4">
                    <div className="panel">
                       <div className="panel-header">
                         <div className="panel-title">{tr("colResults")}</div>
                       </div>

                       {/* Pool */}
                       <div className="mb-6">
                          <div className="flex justify-between items-center mb-3">
                             <div className="text-xs font-bold text-muted uppercase">{tr("assetPool")}</div>
                             <div className="text-xs mono text-dim">{tr("selected", { count: poolSelectedCount })}</div>
                          </div>
                          
                          <div className="pool-list">
                             {poolItems.length === 0 ? (
                               <div className="text-center text-xs text-muted py-6">{tr("noItemsInPool")}</div>
                             ) : poolItems.map(item => (
                               <div key={item.id} className="pool-item">
                                  <div className="pt-1">
                                     <input
                                        type="checkbox"
                                        checked={item.selected}
                                        onChange={(e) => void onTogglePoolSelected(item.id, e.target.checked)}
                                     />
                                  </div>
                                  <div className="flex-1 overflow-hidden">
                                     <div className="text-sm truncate" title={item.title || ""}>{item.title || tr("untitled")}</div>
                                     <div className="text-xs mono text-dim truncate" title={item.source_url || ""}>{item.source_url || item.kind}</div>
                                  </div>
                               </div>
                             ))}
                          </div>
                       </div>

                       {/* Export */}
                       <div className="border-t border-base pt-6">
                          <div className="text-xs font-bold text-muted uppercase mb-4">{tr("export")}</div>
                          
                          <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
                             <input type="checkbox" checked={zipIncludeVideo} onChange={e => setZipIncludeVideo(e.target.checked)} />
                             <span className="text-sm">{tr("includeOriginalVideo")}</span>
                          </label>

                          <div className="flex flex-col gap-2">
                             <button className="btn btn-secondary w-full" onClick={() => void onGenerateReport()} disabled={reportBusy}>
                               {reportBusy ? tr("generatingReport") : tr("genReport")}
                             </button>
                             <button className="btn btn-secondary w-full" onClick={() => void onEstimateZip()} disabled={zipEstimateBusy}>
                               {zipEstimateBusy ? tr("estimating") : tr("estimateSize")}
                             </button>
                             <button className="btn btn-primary w-full" onClick={() => void onExportZip()} disabled={zipExportBusy} data-testid="export-zip">
                               {zipExportBusy ? tr("exporting") : tr("exportZip")}
                             </button>
                          </div>

                          {(reportError || zipEstimateError || zipExportError) && (
                            <div className="alert mt-4">{reportError || zipEstimateError || zipExportError}</div>
                          )}

                          <div className="mt-4 text-xs">
                             {reportOut && <div className="text-success mb-2 font-medium">{tr("reportManifestGenerated")}</div>}
                             {zipEstimate && <div className="mono mb-2">{tr("estimateLabel")} {bytesToSize(zipEstimate.total_bytes)}</div>}
                             {zipExport && (
                               <div className="flex flex-col gap-1 mt-2 p-3 bg-input border border-base rounded-md">
                                  <div className="flex justify-between items-center">
                                    <span className="text-success font-bold">{tr("zipReady")}</span>
                                    <span className="mono text-muted">{bytesToSize(zipExport.total_bytes)}</span>
                                  </div>
                                  <a href={`/tool${zipExport.download_url}`} className="text-primary hover:underline mt-1 block font-medium">
                                    {tr("download")}
                                  </a>
                               </div>
                             )}
                          </div>
                       </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

       {/* Consent Modal */}
       {consentModalOpen && (
        <div className="modal-backdrop" data-testid="consent-modal">
           <div className="modal-content">
              <h3 className="text-lg font-bold mb-3">{tr("externalContentWarningTitle")}</h3>
              <p className="text-sm text-muted mb-4 leading-relaxed">{tr("externalContentWarningText")}</p>
              <div className="code-block text-xs text-primary mb-6 break-all">
                 {consentModalUrl}
              </div>

              <label className="flex items-center gap-2 mb-6 cursor-pointer select-none justify-center">
                  <input
                    type="checkbox"
                    checked={consentModalAutoConfirm}
                    onChange={e => setConsentModalAutoConfirm(e.target.checked)}
                    disabled={consentModalBusy}
                    data-testid="consent-auto-confirm"
                  />
                  <span className="text-sm">{tr("autoConfirmForThisProject")}</span>
               </label>

              {consentModalError && <div className="alert mb-4">{consentModalError}</div>}

               <div className="flex justify-end gap-3">
                 <button
                   className="btn btn-ghost"
                   onClick={() => setConsentModalOpen(false)}
                   disabled={consentModalBusy}
                   data-testid="consent-cancel"
                 >
                     {tr("cancel")}
                  </button>
                 <button
                   className="btn btn-primary"
                   onClick={() => void onConfirmConsentAndSaveUrl()}
                   disabled={consentModalBusy}
                   data-testid="consent-confirm"
                 >
                     {consentModalBusy ? tr("confirming") : tr("iConfirm")}
                  </button>
               </div>
            </div>
         </div>
       )}
    </div>
  );
}
