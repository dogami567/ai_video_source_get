import React from "react";

import { getInitialLocale, persistLocale, t, type I18nVars, type Locale, type MessageKey } from "./i18n";

type OrchestratorHealth = { ok: boolean; service?: string };
type ToolserverHealth = { ok: boolean; service: string; ffmpeg: boolean; data_dir: string; db_path: string };
type OrchestratorConfig = { ok: boolean; default_model: string; base_url: string };

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
  return isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
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

  const [view, setView] = React.useState<{ kind: "list" } | { kind: "project"; projectId: string }>({
    kind: "list",
  });

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

  const [analysisModel, setAnalysisModel] = React.useState("gemini-3-pro-preview");
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
        if (!cancelled && cfg?.default_model) setAnalysisModel(cfg.default_model);
      } catch {
        // ignore config errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      }>(`/api/projects/${view.projectId}/exa/search`, { query });
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
        { url },
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
    <div className="app fade-in">
      <header className="header row row-between row-center">
        <div>
          <h1 className="logo-text">{tr("appTitle")}</h1>
          <p className="subtitle">{tr("appSubtitle")}</p>
        </div>
        <div className="status-cluster">
          <div className="row row-gap row-center">
            <button className="btn btn-ghost btn-xs" onClick={toggleLocale} title={tr("langToggleTitle")}>
              {locale === "en" ? tr("langZH") : tr("langEN")}
            </button>
            {healthError ? (
              <span className="badge badge-error">{tr("systemError")}</span>
            ) : (
              <div className="row row-gap">
                <div className={`status-dot ${orchHealth?.ok ? "ok" : "err"}`} title={tr("orchestrator")} />
                <div className={`status-dot ${toolHealth?.ok ? "ok" : "err"}`} title={tr("toolserver")} />
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="main-content">
        {view.kind === "list" ? (
          <section className="panel animate-slide-up">
            <div className="panel-header row row-between row-center">
              <h2>{tr("projects")}</h2>
              <button className="btn btn-ghost" onClick={refreshProjects} disabled={projectsLoading}>
                {tr("refresh")}
              </button>
            </div>

            <div className="control-group row row-gap">
              <input
                className="input"
                placeholder={tr("newProjectTitlePlaceholder")}
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                disabled={createBusy}
              />
              <button className="btn btn-primary" onClick={onCreateProject} disabled={createBusy}>
                {createBusy ? tr("creating") : tr("createProject")}
              </button>
            </div>

            {projectsError && <div className="alert alert-error">{projectsError}</div>}
            
            <div className="project-list">
              {projectsLoading ? (
                <div className="skeleton-loader">{tr("loadingProjects")}</div>
              ) : projects.length === 0 ? (
                <div className="empty-state">{tr("emptyProjects")}</div>
              ) : (
                <div className="table">
                  <div className="table-head">
                    <div className="col">{tr("title")}</div>
                    <div className="col">{tr("created")}</div>
                    <div className="col right">{tr("action")}</div>
                  </div>
                  {projects.map((p) => (
                    <div key={p.id} className="table-row">
                      <div className="col mono title-cell">{p.title || tr("untitled")}</div>
                      <div className="col muted mono text-sm">{formatTs(p.created_at_ms)}</div>
                      <div className="col right">
                        <button className="btn btn-sm btn-secondary" onClick={() => onOpenProject(p.id)}>
                          {tr("open")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : (
          <div className="project-view animate-slide-up">
            <div className="navbar row row-between row-center">
              <div className="breadcrumb">
                <button className="btn btn-text" onClick={onBackToList}>&larr; {tr("backToProjects")}</button>
                <span className="sep">/</span>
                <span className="current">{project?.title || tr("untitled")}</span>
              </div>
              <div className="meta mono text-xs muted">{tr("idLabel")}: {view.projectId}</div>
            </div>

            {projectError && <div className="alert alert-error">{projectError}</div>}
            {projectLoading && <div className="skeleton-loader">{tr("loadingProjectData")}</div>}

            {project && (
              <div className="dashboard-grid">
                {/* Left Column: Configuration & Inputs */}
                <div className="column-config">
                  <section className="panel">
                    <h3 className="panel-title">{tr("settings")}</h3>
                    <div className="setting-item">
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={!!consent?.auto_confirm}
                          onChange={(e) => void onToggleAutoConfirm(e.target.checked)}
                          disabled={!consent?.consented}
                        />
                        <span className="label-text">{tr("autoConfirmDownloads")}</span>
                      </label>
                      <div className="status-indicator">
                        {tr("consent")}: <span className={consent?.consented ? "text-ok" : "text-warn"}>{consent?.consented ? tr("granted") : tr("pending")}</span>
                      </div>
                    </div>
                    
                    <div className="setting-item">
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={settings?.think_enabled ?? true}
                          onChange={(e) => void onToggleThink(e.target.checked)}
                        />
                        <span className="label-text">{tr("enableReasoning")}</span>
                      </label>
                    </div>
                    
                    {(settings?.think_enabled ?? true) && lastPlan != null && (
                      <div className="mini-terminal">
                        <div className="terminal-header">{tr("latestPlan")}</div>
                        <pre className="code-block">{JSON.stringify(lastPlan, null, 2)}</pre>
                      </div>
                    )}
                  </section>

                  <section className="panel">
                    <h3 className="panel-title">{tr("inputs")}</h3>
                    <div className="input-group">
                      <label>{tr("localVideo")}</label>
                      <div className="row row-gap">
                        <input
                          className="file-input"
                          type="file"
                          accept="video/*"
                          onChange={(e) => setLocalFile(e.target.files?.item(0) || null)}
                          disabled={importBusy}
                        />
                        <button className="btn btn-secondary" onClick={onImportLocal} disabled={importBusy || !localFile}>
                          {importBusy ? "…" : tr("import")}
                        </button>
                      </div>
                      {localFile && <div className="file-name mono">{localFile.name}</div>}
                      {importError && <div className="text-error text-xs">{importError}</div>}
                    </div>

                    <div className="input-group">
                      <label>{tr("videoUrl")}</label>
                      <div className="row row-gap">
                        <input
                          className="input"
                          placeholder="https://..."
                          value={inputUrl}
                          onChange={(e) => setInputUrl(e.target.value)}
                          disabled={saveUrlBusy}
                        />
                        <button className="btn btn-secondary" onClick={onSaveUrl} disabled={saveUrlBusy}>
                          {tr("save")}
                        </button>
                      </div>
                      {saveUrlError && <div className="text-error text-xs">{saveUrlError}</div>}
                    </div>

                    <div className="inventory">
                      <div className="inventory-section">
                        <h4>{tr("videosCount", { count: inputVideos.length })}</h4>
                        <ul className="list-mono">
                          {inputVideos.map(a => <li key={a.id} title={a.path}>{a.path}</li>)}
                        </ul>
                      </div>
                      <div className="inventory-section">
                        <h4>{tr("urlsCount", { count: inputUrls.length })}</h4>
                         <ul className="list-mono">
                          {inputUrls.map(a => <li key={a.id} title={a.path}>{a.path}</li>)}
                        </ul>
                      </div>
                    </div>
                  </section>
                </div>

                {/* Right Column: Actions & Results */}
                <div className="column-actions">
                  <section className="panel">
                    <h3 className="panel-title">{tr("analysis")}</h3>
                    <div className="control-bar">
                      <input
                        className="input"
                        placeholder={tr("modelIdPlaceholder")}
                        value={analysisModel}
                        onChange={(e) => setAnalysisModel(e.target.value)}
                        disabled={analysisBusy}
                      />
                      <select
                        className="select"
                        value={analysisVideoArtifactId}
                        onChange={(e) => setAnalysisVideoArtifactId(e.target.value)}
                        disabled={analysisBusy || inputVideos.length === 0}
                      >
                        {inputVideos.length === 0 ? (
                          <option value="">{tr("noVideoAvailable")}</option>
                        ) : (
                          inputVideos.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.path}
                            </option>
                          ))
                        )}
                      </select>
                      <button className="btn btn-primary" onClick={() => void onRunAnalysis()} disabled={analysisBusy}>
                        {analysisBusy ? tr("analyzing") : tr("runAnalysis")}
                      </button>
                    </div>
                    {analysisError && <div className="alert alert-error">{analysisError}</div>}
                    
                    <div className="analysis-output">
                      {analysisParsed ? (
                         <pre className="code-block">{JSON.stringify(analysisParsed, null, 2)}</pre>
                      ) : analysisText ? (
                         <pre className="code-block">{analysisText}</pre>
                      ) : (
                        <div className="placeholder-text">{tr("analysisPlaceholder")}</div>
                      )}
                    </div>
                  </section>

                  <section className="panel">
                    <div className="panel-header row row-between">
                       <h3 className="panel-title">{tr("contextSearch")}</h3>
                       <div className="usage-stats mono text-xs">
                         {tr("usageStats", { exa: exaSearchCount, fetch: webFetchCount })}
                       </div>
                    </div>
                    
                    <div className="control-bar">
                      <input
                        className="input"
                        placeholder={tr("searchQueryPlaceholder")}
                        value={exaQuery}
                        onChange={(e) => setExaQuery(e.target.value)}
                        disabled={exaBusy || fetchBusy}
                      />
                      <button className="btn btn-secondary" onClick={() => void onExaSearch()} disabled={exaBusy || fetchBusy}>
                        {exaBusy ? tr("searching") : tr("search")}
                      </button>
                    </div>
                    {exaError && <div className="alert alert-error">{exaError}</div>}
                    
                    {exaResults.length > 0 && (
                      <div className="results-list">
                         {exaResults.map((r, idx) => (
                           <div key={`${idx}`} className="result-item">
                             <div className="result-main">
                               <div className="result-title">{r.title || tr("untitled")}</div>
                               <a href={r.url} target="_blank" rel="noopener noreferrer" className="result-url mono">{r.url}</a>
                             </div>
                             <div className="result-actions">
                                <button
                                  className="btn btn-xs btn-secondary"
                                  onClick={() => (r.url ? void onWebFetch(r.url) : undefined)}
                                  disabled={!r.url || fetchBusy || exaBusy}
                                >
                                  {tr("fetch")}
                                </button>
                                <button
                                  className="btn btn-xs btn-secondary"
                                  onClick={() => (r.url ? void onAddToPool(r.url, r.title) : undefined)}
                                  disabled={!r.url}
                                >
                                  {tr("add")}
                                </button>
                             </div>
                           </div>
                         ))}
                      </div>
                    )}
                    
                    {fetchUrl && (
                      <div className="fetch-preview">
                        <div className="preview-label">{tr("fetched", { url: fetchUrl })}</div>
                        {fetchError ? (
                           <div className="text-error">{fetchError}</div>
                        ) : fetchRaw ? (
                           <pre className="code-block xs">{JSON.stringify(fetchRaw, null, 2)}</pre>
                        ) : null}
                      </div>
                    )}
                  </section>

                  <section className="panel">
                    <div className="panel-header row row-between">
                      <h3 className="panel-title">{tr("assetPool")}</h3>
                      <div className="text-xs muted mono">{tr("selected", { count: poolSelectedCount })}</div>
                    </div>
                    
                    <div className="pool-list">
                      {poolItems.length === 0 ? (
                        <div className="placeholder-text">{tr("noItemsInPool")}</div>
                      ) : (
                        <div className="table">
                          <div className="table-head">
                             <div className="col">{tr("asset")}</div>
                             <div className="col">{tr("source")}</div>
                             <div className="col right">{tr("select")}</div>
                          </div>
                          {poolItems.map(it => (
                            <div key={it.id} className="table-row">
                               <div className="col">
                                 <div className="font-medium">{it.title || tr("untitled")}</div>
                                 <div className="badge badge-subtle">{it.kind}</div>
                               </div>
                               <div className="col mono text-xs text-truncate" title={it.source_url || ""}>
                                 {it.source_url || "-"}
                               </div>
                               <div className="col right">
                                 <label className="checkbox-wrapper">
                                    <input
                                      type="checkbox"
                                      checked={it.selected}
                                      onChange={(e) => void onTogglePoolSelected(it.id, e.target.checked)}
                                    />
                                    <span className="checkbox-custom"></span>
                                 </label>
                               </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                  
                  <section className="panel">
                    <h3 className="panel-title">{tr("export")}</h3>
                    <div className="export-controls">
                      <div className="row row-between row-center mb-4">
                        <label className="toggle">
                          <input type="checkbox" checked={zipIncludeVideo} onChange={(e) => setZipIncludeVideo(e.target.checked)} />
                          <span className="label-text">{tr("includeOriginalVideo")}</span>
                        </label>
                      </div>
                      
                      <div className="button-group">
                         <button className="btn btn-secondary" onClick={() => void onGenerateReport()} disabled={reportBusy}>
                           {reportBusy ? tr("generatingReport") : tr("genReport")}
                         </button>
                         <button className="btn btn-secondary" onClick={() => void onEstimateZip()} disabled={zipEstimateBusy || zipExportBusy}>
                           {zipEstimateBusy ? tr("estimating") : tr("estimateSize")}
                         </button>
                         <button className="btn btn-primary" onClick={() => void onExportZip()} disabled={zipExportBusy}>
                           {zipExportBusy ? tr("exporting") : tr("exportZip")}
                         </button>
                      </div>
                      
                      {(reportError || zipEstimateError || zipExportError) && (
                         <div className="alert alert-error mt-4">
                            {reportError} {zipEstimateError} {zipExportError}
                         </div>
                      )}

                      {(reportOut || zipEstimate || zipExport) && (
                        <div className="export-status mt-4">
                           {reportOut && <div className="status-line text-ok">{tr("reportManifestGenerated")}</div>}
                           {zipEstimate && (
                             <div className="status-line">
                               {tr("estimateLabel")} <span className="mono">{bytesToSize(zipEstimate.total_bytes)}</span>
                             </div>
                           )}
                           {zipExport && (
                             <div className="status-line">
                               <span className="text-ok">{tr("zipReady")}</span> <span className="mono">{bytesToSize(zipExport.total_bytes)}</span>
                               <a className="download-link ml-2" href={`/tool${zipExport.download_url}`}>{tr("download")}</a>
                             </div>
                           )}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {consentModalOpen && (
        <div className="modal-backdrop fade-in" role="dialog" aria-modal="true">
          <div className="modal animate-pop">
            <h3 className="modal-title">{tr("externalContentWarningTitle")}</h3>
            <p className="modal-text">
              {tr("externalContentWarningText")}
            </p>
            <div className="modal-code">{consentModalUrl}</div>
            
            <label className="toggle mt-4">
              <input
                type="checkbox"
                checked={consentModalAutoConfirm}
                onChange={(e) => setConsentModalAutoConfirm(e.target.checked)}
                disabled={consentModalBusy}
              />
              <span className="label-text">{tr("autoConfirmForThisProject")}</span>
            </label>
            
            {consentModalError && <div className="alert alert-error mt-4">{consentModalError}</div>}
            
            <div className="modal-actions row row-right row-gap mt-6">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setConsentModalOpen(false);
                  setConsentModalUrl(null);
                  setConsentModalError(null);
                }}
                disabled={consentModalBusy}
              >
                {tr("cancel")}
              </button>
              <button className="btn btn-primary" onClick={() => void onConfirmConsentAndSaveUrl()} disabled={consentModalBusy}>
                {consentModalBusy ? tr("confirming") : tr("iConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
