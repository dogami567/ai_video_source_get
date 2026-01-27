import React from "react";
import { getInitialLocale, persistLocale, t, type I18nVars, type Locale, type MessageKey } from "./i18n";

// --- Types ---
type OrchestratorHealth = { ok: boolean; service?: string };
type ToolserverHealth = {
  ok: boolean;
  service: string;
  ffmpeg: boolean;
  ffprobe: boolean;
  ytdlp: boolean;
  data_dir: string;
  db_path: string;
};
type OrchestratorConfig = { ok: boolean; default_model: string; base_url: string };

type ClientConfig = {
  base_url?: string;
  gemini_api_key?: string;
  exa_api_key?: string;
  default_model?: string;
  ytdlp_cookies_from_browser?: string;
};

type Project = { id: string; title: string; created_at_ms: number };
type Consent = { project_id: string; consented: boolean; auto_confirm: boolean; updated_at_ms: number };
type ProjectSettings = { project_id: string; think_enabled: boolean; updated_at_ms: number };
type Artifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ImportLocalResponse = { artifact: Artifact; bytes: number; file_name: string };
type RemoteMediaInfoSummary = {
  extractor: string;
  id: string;
  title: string;
  duration_s: number | null;
  webpage_url: string;
  thumbnail?: string | null;
  description?: string | null;
};
type ImportRemoteMediaResponse = { info: RemoteMediaInfoSummary; info_artifact: Artifact; input_video?: Artifact | null };
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

type ChatThread = { id: string; project_id: string; title: string; created_at_ms: number };
type ChatMessage = {
  id: string;
  project_id: string;
  chat_id: string;
  role: string;
  content: string;
  data?: any;
  created_at_ms: number;
};

type UploadFileArtifactResponse = { artifact: Artifact; bytes: number; file_name: string; mime: string | null };
type ChatAttachment = { artifact: Artifact; bytes: number; file_name: string; mime: string | null };
type ChatTurnResponse = {
  ok: boolean;
  needs_consent?: boolean;
  plan?: unknown | null;
  plan_artifact?: Artifact | null;
  user_message: ChatMessage;
  assistant_message: ChatMessage;
  mock?: boolean;
};

const CLIENT_CONFIG_KEY = "vidunpack_client_config_v1";

function normalizeClientConfig(cfg: ClientConfig): ClientConfig {
  const out: ClientConfig = {};
  const baseUrl = cfg.base_url?.trim();
  const geminiKey = cfg.gemini_api_key?.trim();
  const exaKey = cfg.exa_api_key?.trim();
  const defaultModel = cfg.default_model?.trim();
  const ytdlpCookiesFromBrowser = cfg.ytdlp_cookies_from_browser?.trim();

  if (baseUrl) out.base_url = baseUrl;
  if (geminiKey) out.gemini_api_key = geminiKey;
  if (exaKey) out.exa_api_key = exaKey;
  if (defaultModel) out.default_model = defaultModel;
  if (ytdlpCookiesFromBrowser) out.ytdlp_cookies_from_browser = ytdlpCookiesFromBrowser;

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
      ytdlp_cookies_from_browser:
        typeof obj.ytdlp_cookies_from_browser === "string" ? obj.ytdlp_cookies_from_browser : undefined,
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
  const cleaned = text.replace(/^\uFEFF/, "");
  let parsed: unknown = null;
  try {
    parsed = cleaned ? (JSON.parse(cleaned) as unknown) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { error?: unknown };
      if (typeof obj.error === "string" && obj.error.trim()) throw new Error(obj.error);
    }
    throw new Error(cleaned || `HTTP ${res.status}`);
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { ok?: unknown; error?: unknown };
    if (obj.ok === false && typeof obj.error === "string" && obj.error.trim()) {
      throw new Error(obj.error);
    }
  }
  return (parsed === null ? (JSON.parse(cleaned) as T) : (parsed as T));
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
        <button className="btn btn-ghost btn-sm" onClick={onOpenSettings} type="button" data-testid="open-settings">
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
  const [projectTab, setProjectTab] = React.useState<"workspace" | "chat">("workspace");
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
      ytdlp_cookies_from_browser: cfg.ytdlp_cookies_from_browser ?? "",
    };
  });
  const [settingsSavedAt, setSettingsSavedAt] = React.useState<number | null>(null);
  const [systemBrowsers, setSystemBrowsers] = React.useState<string[] | null>(null);
  const [systemBrowsersError, setSystemBrowsersError] = React.useState<string | null>(null);

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
  const [remoteBusyId, setRemoteBusyId] = React.useState<string | null>(null);
  const [remoteError, setRemoteError] = React.useState<string | null>(null);
  const [remoteInfoByUrl, setRemoteInfoByUrl] = React.useState<Record<string, RemoteMediaInfoSummary>>({});

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

  const [zipIncludeReport, setZipIncludeReport] = React.useState(true);
  const [zipIncludeManifest, setZipIncludeManifest] = React.useState(true);
  const [zipIncludeVideo, setZipIncludeVideo] = React.useState(true);
  const [zipIncludeClips, setZipIncludeClips] = React.useState(true);
  const [zipIncludeAudio, setZipIncludeAudio] = React.useState(false);
  const [zipIncludeThumbnails, setZipIncludeThumbnails] = React.useState(true);
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

  const lastProjectIdRef = React.useRef<string | null>(null);

  const [chatThreads, setChatThreads] = React.useState<ChatThread[]>([]);
  const [chatThreadsLoading, setChatThreadsLoading] = React.useState(false);
  const [chatThreadsError, setChatThreadsError] = React.useState<string | null>(null);

  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
  const [chatMessagesLoading, setChatMessagesLoading] = React.useState(false);
  const [chatMessagesError, setChatMessagesError] = React.useState<string | null>(null);

  const [chatDraft, setChatDraft] = React.useState("");
  const [chatSendBusy, setChatSendBusy] = React.useState(false);
  const [chatSendError, setChatSendError] = React.useState<string | null>(null);

  const [chatAttachments, setChatAttachments] = React.useState<ChatAttachment[]>([]);
  const [chatUploadBusy, setChatUploadBusy] = React.useState(false);
  const [chatUploadError, setChatUploadError] = React.useState<string | null>(null);

  const [chatCardBusyUrl, setChatCardBusyUrl] = React.useState<string | null>(null);
  const [chatCardError, setChatCardError] = React.useState<string | null>(null);

  const chatEndRef = React.useRef<HTMLDivElement | null>(null);
  const chatFileInputRef = React.useRef<HTMLInputElement | null>(null);

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

  // Dev UX: orchestrator may start a bit later than Vite; keep retrying health until both services are up.
  React.useEffect(() => {
    const needsRetry = !!healthError || !orchHealth?.ok || !toolHealth?.ok;
    if (!needsRetry) return;

    const id = window.setInterval(() => {
      void refreshHealth();
    }, 2000);

    return () => {
      window.clearInterval(id);
    };
  }, [healthError, orchHealth?.ok, refreshHealth, toolHealth?.ok]);

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
    setRemoteBusyId(null);
    setRemoteError(null);
    setRemoteInfoByUrl({});
    void refreshProject(view.projectId);
  }, [refreshProject, view]);

  React.useEffect(() => {
    if (view.kind !== "project") return;
    if (lastProjectIdRef.current === view.projectId) return;
    lastProjectIdRef.current = view.projectId;

    setProjectTab("workspace");
    setChatThreads([]);
    setChatThreadsError(null);
    setActiveChatId(null);
    setChatMessages([]);
    setChatMessagesError(null);
    setChatDraft("");
    setChatAttachments([]);
    setChatSendError(null);
    setChatUploadError(null);
    setChatCardError(null);
  }, [view.kind, view.kind === "project" ? view.projectId : ""]);

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

  const refreshSystemBrowsers = async () => {
    setSystemBrowsersError(null);
    setSystemBrowsers(null);
    try {
      const resp = await fetchJson<{ ok: boolean; browsers?: string[] }>(`/api/system/browsers`);
      setSystemBrowsers(Array.isArray(resp.browsers) ? resp.browsers : []);
    } catch (e) {
      setSystemBrowsersError(e instanceof Error ? e.message : String(e));
    }
  };

  const onOpenSettings = () => {
    returnFromSettings.current = view.kind === "settings" ? { kind: "list" } : view;
    setSettingsDraft({
      base_url: clientConfig.base_url ?? "",
      gemini_api_key: clientConfig.gemini_api_key ?? "",
      exa_api_key: clientConfig.exa_api_key ?? "",
      default_model: clientConfig.default_model ?? "",
      ytdlp_cookies_from_browser: clientConfig.ytdlp_cookies_from_browser ?? "",
    });
    setSettingsSavedAt(null);
    void refreshSystemBrowsers();
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
      ytdlp_cookies_from_browser: settingsDraft.ytdlp_cookies_from_browser,
    });
    saveClientConfig(next);
    setClientConfig(next);
    if (next.default_model) setAnalysisModel(next.default_model);
    setSettingsSavedAt(Date.now());
  };

  const onClearSettings = () => {
    saveClientConfig({});
    setClientConfig({});
    setSettingsDraft({ base_url: "", gemini_api_key: "", exa_api_key: "", default_model: "", ytdlp_cookies_from_browser: "" });
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
    setRemoteBusyId(null);
    setRemoteError(null);
    setRemoteInfoByUrl({});
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

  const onResolveOrDownloadRemote = async (u: Artifact, download: boolean) => {
    if (view.kind !== "project") return;
    setRemoteError(null);

    if (download && toolHealth && !toolHealth.ffmpeg) {
      setRemoteError(tr("errFfmpegRequiredForDownload"));
      return;
    }

    setRemoteBusyId(u.id);
    try {
      const resp = await postJson<ImportRemoteMediaResponse>(`/tool/projects/${view.projectId}/media/remote`, {
        url: u.path,
        download,
        cookies_from_browser: clientConfig.ytdlp_cookies_from_browser,
      });
      setRemoteInfoByUrl((prev) => ({ ...prev, [u.path]: resp.info }));
      await refreshProject(view.projectId);
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusyId(null);
    }
  };

  const refreshChatThreads = React.useCallback(async (projectId: string) => {
    setChatThreadsLoading(true);
    setChatThreadsError(null);
    try {
      const threads = await fetchJson<ChatThread[]>(`/tool/projects/${projectId}/chats`);
      setChatThreads(threads);
      return threads;
    } catch (e) {
      setChatThreadsError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setChatThreadsLoading(false);
    }
  }, []);

  const createChatThread = React.useCallback(async (projectId: string, title?: string) => {
    const created = await postJson<ChatThread>(`/tool/projects/${projectId}/chats`, { title: title?.trim() || undefined });
    setChatThreads((prev) => [created, ...prev.filter((t) => t.id !== created.id)]);
    setActiveChatId(created.id);
    setChatMessages([]);
    return created;
  }, []);

  const loadChatMessages = React.useCallback(async (projectId: string, chatId: string) => {
    setChatMessagesLoading(true);
    setChatMessagesError(null);
    try {
      const msgs = await fetchJson<ChatMessage[]>(`/tool/projects/${projectId}/chats/${chatId}/messages`);
      setChatMessages(msgs);
      return msgs;
    } catch (e) {
      setChatMessagesError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setChatMessagesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (view.kind !== "project") return;
    if (projectTab !== "chat") return;

    let cancelled = false;
    (async () => {
      const threads = await refreshChatThreads(view.projectId);
      if (cancelled || !threads) return;

      const hasActive = !!activeChatId && threads.some((t) => t.id === activeChatId);
      if (hasActive) return;

      if (threads.length > 0) {
        setActiveChatId(threads[0].id);
        return;
      }

      try {
        const created = await createChatThread(view.projectId);
        if (cancelled) return;
        setChatThreads([created]);
        setActiveChatId(created.id);
      } catch (e) {
        if (cancelled) return;
        setChatThreadsError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [createChatThread, projectTab, refreshChatThreads, view.kind, view.kind === "project" ? view.projectId : ""]);

  React.useEffect(() => {
    if (view.kind !== "project") return;
    if (projectTab !== "chat") return;
    if (!activeChatId) return;

    let cancelled = false;
    (async () => {
      const msgs = await loadChatMessages(view.projectId, activeChatId);
      if (cancelled) return;
      if (!msgs) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, loadChatMessages, projectTab, view.kind, view.kind === "project" ? view.projectId : ""]);

  React.useEffect(() => {
    if (projectTab !== "chat") return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, projectTab]);

  const onChatNewThread = async () => {
    if (view.kind !== "project") return;
    setChatThreadsError(null);
    try {
      await createChatThread(view.projectId);
    } catch (e) {
      setChatThreadsError(e instanceof Error ? e.message : String(e));
    }
  };

  const onChatUploadFiles = async (files: FileList | null) => {
    if (view.kind !== "project") return;
    if (!files || files.length === 0) return;

    setChatUploadBusy(true);
    setChatUploadError(null);
    try {
      const uploaded: ChatAttachment[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/tool/projects/${view.projectId}/artifacts/upload`, { method: "POST", body: form });
        const text = await res.text();
        if (!res.ok) {
          try {
            const parsed = JSON.parse(text) as { error?: string };
            throw new Error(parsed.error || `HTTP ${res.status}`);
          } catch {
            throw new Error(text || `HTTP ${res.status}`);
          }
        }
        const json = JSON.parse(text) as UploadFileArtifactResponse;
        uploaded.push({ artifact: json.artifact, bytes: json.bytes, file_name: json.file_name, mime: json.mime });
      }
      setChatAttachments((prev) => [...prev, ...uploaded]);
      await refreshProject(view.projectId);
    } catch (e) {
      setChatUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatUploadBusy(false);
      if (chatFileInputRef.current) chatFileInputRef.current.value = "";
    }
  };

  const onChatRemoveAttachment = (artifactId: string) => {
    setChatAttachments((prev) => prev.filter((a) => a.artifact.id !== artifactId));
  };

  const onChatSend = async () => {
    if (view.kind !== "project") return;
    if (!activeChatId) return;

    setChatSendError(null);
    const message = chatDraft.trimEnd();
    if (!message.trim()) {
      setChatSendError(tr("errEnterMessage"));
      return;
    }

    setChatSendBusy(true);
    try {
      const resp = await postJson<ChatTurnResponse>(`/api/projects/${view.projectId}/chat/turn`, {
        chat_id: activeChatId,
        message,
        base_url: clientConfig.base_url,
        gemini_api_key: clientConfig.gemini_api_key,
        exa_api_key: clientConfig.exa_api_key,
        default_model: clientConfig.default_model,
        ytdlp_cookies_from_browser: clientConfig.ytdlp_cookies_from_browser,
        attachments: chatAttachments.map((a) => ({
          artifact_id: a.artifact.id,
          file_name: a.file_name,
          mime: a.mime || "",
          bytes: a.bytes,
        })),
      });
      setChatDraft("");
      setChatAttachments([]);
      setChatMessages((prev) => [...prev, resp.user_message, resp.assistant_message]);
      if (resp.plan !== undefined) setLastPlan(resp.plan ?? null);
      if (resp.plan_artifact !== undefined) setLastPlanArtifact(resp.plan_artifact ?? null);
      await refreshProject(view.projectId);
    } catch (e) {
      setChatSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatSendBusy(false);
    }
  };

  const onChatCardResolveOrDownload = async (url: string, download: boolean) => {
    if (view.kind !== "project") return;
    setChatCardError(null);

    if (download && toolHealth && !toolHealth.ffmpeg) {
      setChatCardError(tr("errFfmpegRequiredForDownload"));
      return;
    }

    if (!consent?.consented) {
      setConsentModalUrl(url);
      setConsentModalOpen(true);
      return;
    }

    setChatCardBusyUrl(url);
    try {
      const resp = await postJson<ImportRemoteMediaResponse>(`/tool/projects/${view.projectId}/media/remote`, {
        url,
        download,
        cookies_from_browser: clientConfig.ytdlp_cookies_from_browser,
      });
      setRemoteInfoByUrl((prev) => ({ ...prev, [url]: resp.info }));
      await refreshProject(view.projectId);
    } catch (e) {
      setChatCardError(e instanceof Error ? e.message : String(e));
    } finally {
      setChatCardBusyUrl(null);
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
        {
          include_report: zipIncludeReport,
          include_manifest: zipIncludeManifest,
          include_original_video: zipIncludeVideo,
          include_clips: zipIncludeClips,
          include_audio: zipIncludeAudio,
          include_thumbnails: zipIncludeThumbnails,
        },
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
      if (zipIncludeReport || zipIncludeManifest) {
        const hasReport = artifacts.some((a) => a.kind === "report_html");
        const hasManifest = artifacts.some((a) => a.kind === "manifest_json");
        if (!hasReport || !hasManifest) {
          const generated = await fetchJson<{ report_html: Artifact; manifest_json: Artifact }>(
            `/tool/projects/${view.projectId}/exports/report`,
            { method: "POST" },
          );
          setReportOut(generated);
          await refreshProject(view.projectId);
        }
      }

      const resp = await postJson<{ zip: Artifact; total_bytes: number; download_url: string }>(
        `/tool/projects/${view.projectId}/exports/zip`,
        {
          include_report: zipIncludeReport,
          include_manifest: zipIncludeManifest,
          include_original_video: zipIncludeVideo,
          include_clips: zipIncludeClips,
          include_audio: zipIncludeAudio,
          include_thumbnails: zipIncludeThumbnails,
        },
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
            <div className="alert mb-6" data-testid="backend-offline">
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
                <button className="btn btn-ghost btn-sm" type="button" onClick={onCloseSettings} data-testid="settings-back">
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
                        data-testid="settings-base-url"
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
                        data-testid="settings-gemini-key"
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
                        data-testid="settings-default-model"
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
                        data-testid="settings-exa-key"
                        placeholder={tr("settingsKeyPlaceholder")}
                        value={settingsDraft.exa_api_key}
                        onChange={(e) => setSettingsDraft((p) => ({ ...p, exa_api_key: e.target.value }))}
                      />
                      <div className="text-xs text-dim mt-1">{tr("settingsEmptyUsesEnv")}</div>
                    </div>

                    <div className="text-sm text-muted">{tr("settingsExaHint")}</div>
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <div className="panel-title">{tr("settingsDownloader")}</div>
                    </div>

	                    <div className="input-group">
	                      <label className="input-label">{tr("settingsCookiesFromBrowser")}</label>
	                      <input
	                        className="input-field"
	                        type="text"
	                        data-testid="settings-ytdlp-cookies-from-browser"
	                        placeholder="chrome | edge | firefox"
	                        value={settingsDraft.ytdlp_cookies_from_browser}
	                        onChange={(e) => setSettingsDraft((p) => ({ ...p, ytdlp_cookies_from_browser: e.target.value }))}
	                      />
	                      <div className="text-xs text-dim mt-1">{tr("settingsCookiesFromBrowserHint")}</div>

	                      <div className="flex items-center gap-2 mt-2 flex-wrap">
	                        <button
	                          className="btn btn-secondary btn-sm"
	                          type="button"
	                          onClick={() => {
	                            const url = "https://passport.bilibili.com/login";
	                            const browser = String(settingsDraft.ytdlp_cookies_from_browser || "").trim();
	                            if (!browser) {
	                              window.open(url, "_blank", "noopener,noreferrer");
	                              return;
	                            }
	                            void (async () => {
	                              try {
	                                await postJson<{ ok: boolean }>(`/api/system/open-browser`, { browser, url });
	                              } catch (e) {
	                                const msg = e instanceof Error ? e.message : String(e);
	                                alert(`${tr("openBilibiliLogin")} failed: ${msg}`);
	                                window.open(url, "_blank", "noopener,noreferrer");
	                              }
	                            })();
	                          }}
	                          data-testid="open-bilibili-login"
	                        >
	                          {tr("openBilibiliLogin")}
	                        </button>

	                        <button
	                          className="btn btn-ghost btn-sm"
	                          type="button"
	                          onClick={() => setSettingsDraft((p) => ({ ...p, ytdlp_cookies_from_browser: "edge" }))}
	                          data-testid="set-cookies-edge"
	                        >
	                          Edge
	                        </button>
	                        <button
	                          className="btn btn-ghost btn-sm"
	                          type="button"
	                          onClick={() => setSettingsDraft((p) => ({ ...p, ytdlp_cookies_from_browser: "chrome" }))}
	                          data-testid="set-cookies-chrome"
	                        >
	                          Chrome
	                        </button>
	                        <button
	                          className="btn btn-ghost btn-sm"
	                          type="button"
	                          onClick={() => setSettingsDraft((p) => ({ ...p, ytdlp_cookies_from_browser: "firefox" }))}
	                          data-testid="set-cookies-firefox"
	                        >
	                          Firefox
	                        </button>
	                      </div>
	                      <div className="text-xs text-dim mt-2">
	                        {tr("detectedBrowsers")}:{" "}
	                        <span className="mono">
	                          {systemBrowsersError ? "n/a" : systemBrowsers ? (systemBrowsers.length > 0 ? systemBrowsers.join(", ") : "n/a") : "…"}
	                        </span>
	                      </div>
	                      <div className="text-xs text-dim mt-2">{tr("cookiesLoginWhat")}</div>

                        <div className="mt-3 border-t border-base pt-3">
                          <div className="text-xs text-dim mb-1">{tr("toolDeps")}</div>
                          <div className="text-xs text-muted flex flex-wrap gap-3">
                            <span>
                              yt-dlp:{" "}
                              <span className={toolHealth?.ytdlp ? "text-success" : "text-error"}>
                                {toolHealth?.ytdlp ? tr("toolDepOk") : tr("toolDepMissing")}
                              </span>
                            </span>
                            <span>
                              ffmpeg:{" "}
                              <span className={toolHealth?.ffmpeg ? "text-success" : "text-error"}>
                                {toolHealth?.ffmpeg ? tr("toolDepOk") : tr("toolDepMissing")}
                              </span>
                            </span>
                            <span>
                              ffprobe:{" "}
                              <span className={toolHealth?.ffprobe ? "text-success" : "text-error"}>
                                {toolHealth?.ffprobe ? tr("toolDepOk") : tr("toolDepMissing")}
                              </span>
                            </span>
                          </div>
                          <div className="text-xs text-dim mt-2">{tr("toolDepsHint")}</div>
                          {toolHealth && !toolHealth.ffmpeg ? (
                            <div className="text-xs text-dim mt-2">
                              Windows: <span className="mono">winget install Gyan.FFmpeg</span>
                            </div>
                          ) : null}
                        </div>
	                    </div>
	                  </div>
	                </div>

                <div className="flex items-center justify-between mt-6">
                  <button className="btn btn-ghost btn-sm" type="button" onClick={onClearSettings} data-testid="settings-clear">
                    {tr("clear")}
                  </button>

                  <div className="flex items-center gap-2">
                    {settingsSavedAt && (
                      <span className="text-sm text-muted" data-testid="settings-saved">
                        {tr("saved")}
                      </span>
                    )}
                    <button className="btn btn-primary" type="button" onClick={onSaveSettings} data-testid="settings-save">
                      {tr("save")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
	            <div className="animate-enter">
	              <div className="flex items-center justify-between mb-6 gap-4">
	                <div className="flex items-center gap-2">
	                  <button className="btn btn-ghost btn-sm" onClick={onBackToList} data-testid="back-to-list">
	                    &larr; {tr("backToProjects")}
	                  </button>
	                  <span className="text-dim">/</span>
	                  <span className="font-bold text-lg text-main">{project?.title || tr("untitled")}</span>
	                </div>

	                <div className="segmented" data-testid="project-tabs">
	                  <button
	                    className={`segmented-btn ${projectTab === "workspace" ? "active" : ""}`}
	                    type="button"
	                    onClick={() => setProjectTab("workspace")}
	                    data-testid="project-tab-workspace"
	                  >
	                    {tr("colWorkspace")}
	                  </button>
	                  <button
	                    className={`segmented-btn ${projectTab === "chat" ? "active" : ""}`}
	                    type="button"
	                    onClick={() => setProjectTab("chat")}
	                    data-testid="project-tab-chat"
	                  >
	                    {tr("chat")}
	                  </button>
	                </div>
	              </div>

              {projectError && <div className="alert mb-6">{projectError}</div>}
              {projectLoading && <div className="text-center text-muted mb-4">{tr("loadingProjectData")}</div>}

              {project && (
                <div className="main-layout">
                  {/* --- Left Sidebar: Context & Controls --- */}
                  <aside className="layout-sidebar">
                    <div className="flex flex-col gap-4">
                      
                      {/* Inputs Panel */}
                      <div className="panel">
                        <div className="panel-header">
                          <div className="panel-title">{tr("inputs")}</div>
                        </div>
                        
                        <div className="input-group">
                           <label className="input-label">{tr("localVideo")}</label>
                           <div className="flex gap-2">
                             <input
                                className="flex-1 input-field"
                                type="file"
                                accept="video/*"
                                data-testid="local-file-input"
                                onChange={(e) => setLocalFile(e.target.files?.item(0) || null)}
                                disabled={importBusy}
                             />
                             <button className="btn btn-secondary" onClick={onImportLocal} disabled={importBusy || !localFile} data-testid="import-local">
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

                        <div className="mt-2 border-t border-base pt-4">
                          <div className="text-xs text-dim mb-2">{tr("videosCount", { count: inputVideos.length })}</div>
                          {inputVideos.map(v => <div key={v.id} className="text-xs mono truncate text-muted mb-1" title={v.path}>• {v.path}</div>)}
                          <div className="text-xs text-dim mt-3 mb-2">{tr("urlsCount", { count: inputUrls.length })}</div>
                          {inputUrls.length === 0 ? (
                            <div className="text-xs text-muted">—</div>
                          ) : (
                            <div className="flex flex-col gap-2">
                              {inputUrls.map((u) => {
                                const info = remoteInfoByUrl[u.path];
                                const busy = remoteBusyId === u.id;
                                return (
                                  <div key={u.id} className="flex gap-2 items-center">
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs mono truncate text-muted" title={u.path}>
                                        • {u.path}
                                      </div>
                                      {info && (
                                        <div className="text-xs truncate text-dim" title={info.title}>
                                          {info.title} <span className="mono">({info.extractor})</span>
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex gap-1 shrink-0">
                                      <button
                                        className="btn btn-secondary btn-sm"
                                        type="button"
                                        onClick={() => void onResolveOrDownloadRemote(u, false)}
                                        disabled={busy}
                                      >
                                        {busy ? "…" : tr("resolve")}
                                      </button>
                                       <button
                                         className="btn btn-secondary btn-sm"
                                         type="button"
                                         onClick={() => void onResolveOrDownloadRemote(u, true)}
                                         disabled={busy || (toolHealth ? !toolHealth.ffmpeg : false)}
                                         title={toolHealth && !toolHealth.ffmpeg ? tr("errFfmpegRequiredForDownload") : undefined}
                                       >
                                         {busy ? "…" : tr("downloadNow")}
                                       </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {remoteError && <div className="text-error text-xs mt-2">{remoteError}</div>}
                        </div>
                      </div>

                      {/* Settings Panel */}
                      <div className="panel">
                        <div className="panel-header">
                          <div className="panel-title">{tr("settings")}</div>
                        </div>
                        <div className="flex justify-between items-center mb-4">
                           <span className="text-sm text-secondary">{tr("autoConfirmDownloads")}</span>
                           <label className="toggle-switch" data-testid="toggle-auto-confirm-ui">
                              <input
                                type="checkbox"
                                hidden
                                checked={!!consent?.auto_confirm}
                                onChange={(e) => void onToggleAutoConfirm(e.target.checked)}
                                disabled={!consent?.consented}
                                data-testid="toggle-auto-confirm"
                              />
                              <div className="toggle-track"><div className="toggle-knob"/></div>
                           </label>
                        </div>
                        
                        <div className="flex justify-between items-center">
                           <span className="text-sm text-secondary">{tr("enableReasoning")}</span>
                           <label className="toggle-switch" data-testid="toggle-think-ui">
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

                      {/* Export Panel */}
                      <div className="panel">
                        <div className="panel-header">
                           <div className="panel-title">{tr("export")}</div>
                        </div>
                        
                        <div className="export-options mb-3">
                          <label className={`export-option ${(zipIncludeReport || zipIncludeManifest) ? "on" : ""}`}>
                            <input
                              type="checkbox"
                              checked={zipIncludeReport || zipIncludeManifest}
                              onChange={(e) => {
                                const v = e.target.checked;
                                setZipIncludeReport(v);
                                setZipIncludeManifest(v);
                              }}
                              data-testid="include-report-bundle"
                            />
                            <div className="export-option-body">
                              <div className="export-option-title">{tr("exportReportBundle")}</div>
                              <div className="export-option-desc">{tr("exportReportBundleDesc")}</div>
                            </div>
                          </label>

                          <label className={`export-option ${zipIncludeVideo ? "on" : ""}`}>
                            <input
                              type="checkbox"
                              checked={zipIncludeVideo}
                              onChange={(e) => setZipIncludeVideo(e.target.checked)}
                              data-testid="include-original-video"
                            />
                            <div className="export-option-body">
                              <div className="export-option-title">{tr("includeOriginalVideo")}</div>
                              <div className="export-option-desc">{tr("exportOriginalVideoDesc")}</div>
                            </div>
                          </label>

                          <label className={`export-option ${zipIncludeClips ? "on" : ""}`}>
                            <input
                              type="checkbox"
                              checked={zipIncludeClips}
                              onChange={(e) => setZipIncludeClips(e.target.checked)}
                              data-testid="include-clips"
                            />
                            <div className="export-option-body">
                              <div className="export-option-title">{tr("exportClips")}</div>
                              <div className="export-option-desc">{tr("exportClipsDesc")}</div>
                            </div>
                          </label>

                          <label className={`export-option ${zipIncludeAudio ? "on" : ""}`}>
                            <input
                              type="checkbox"
                              checked={zipIncludeAudio}
                              onChange={(e) => setZipIncludeAudio(e.target.checked)}
                              data-testid="include-audio"
                            />
                            <div className="export-option-body">
                              <div className="export-option-title">{tr("exportAudio")}</div>
                              <div className="export-option-desc">{tr("exportAudioDesc")}</div>
                            </div>
                          </label>

                          <label className={`export-option ${zipIncludeThumbnails ? "on" : ""}`}>
                            <input
                              type="checkbox"
                              checked={zipIncludeThumbnails}
                              onChange={(e) => setZipIncludeThumbnails(e.target.checked)}
                              data-testid="include-thumbnails"
                            />
                            <div className="export-option-body">
                              <div className="export-option-title">{tr("exportThumbnails")}</div>
                              <div className="export-option-desc">{tr("exportThumbnailsDesc")}</div>
                            </div>
                          </label>
                        </div>
                        <div className="text-xs text-dim mb-4">{tr("exportAlwaysIncluded")}</div>

                        <div className="flex flex-col gap-2">
                           <button className="btn btn-secondary w-full" onClick={() => void onGenerateReport()} disabled={reportBusy} data-testid="gen-report">
                             {reportBusy ? tr("generatingReport") : tr("genReport")}
                           </button>
                           <button className="btn btn-secondary w-full" onClick={() => void onEstimateZip()} disabled={zipEstimateBusy} data-testid="estimate-zip">
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
                  </aside>

	                  {/* --- Main Content: Workspace & Results --- */}
	                  <main className="layout-content">
	                    {projectTab === "chat" ? (
	                      <div className="panel chat-panel" data-testid="chat-panel">
	                        <div className="panel-header">
	                          <div className="panel-title">{tr("chat")}</div>
	                          <div className="flex items-center gap-2">
	                            <button
	                              className="btn btn-secondary btn-sm"
	                              type="button"
	                              onClick={() => void refreshChatThreads(view.projectId)}
	                              disabled={chatThreadsLoading}
	                              data-testid="chat-refresh-threads"
	                            >
	                              {tr("refresh")}
	                            </button>
	                            <button
	                              className="btn btn-primary btn-sm"
	                              type="button"
	                              onClick={() => void onChatNewThread()}
	                              disabled={chatThreadsLoading}
	                              data-testid="chat-new-thread"
	                            >
	                              + {tr("newChat")}
	                            </button>
	                          </div>
	                        </div>

	                        <div className="chat-split">
	                          <div className="chat-thread-col" data-testid="chat-threads">
	                            {chatThreadsError && <div className="alert mb-4">{chatThreadsError}</div>}
	                            {chatThreadsLoading ? (
	                              <div className="text-center text-muted text-sm py-6">{tr("loadingChats")}</div>
	                            ) : chatThreads.length === 0 ? (
	                              <div className="text-center text-muted text-sm py-6">{tr("noChats")}</div>
	                            ) : (
	                              <div className="chat-thread-list">
	                                {chatThreads.map((c) => (
	                                  <button
	                                    key={c.id}
	                                    type="button"
	                                    className={`chat-thread ${c.id === activeChatId ? "active" : ""}`}
	                                    onClick={() => setActiveChatId(c.id)}
	                                    data-testid={`chat-thread-${c.id}`}
	                                  >
	                                    <div className="chat-thread-title">{c.title || tr("untitled")}</div>
	                                    <div className="chat-thread-meta mono">{formatTs(c.created_at_ms)}</div>
	                                  </button>
	                                ))}
	                              </div>
	                            )}
	                          </div>

	                          <div className="chat-main-col">
	                            <div className="chat-messages" data-testid="chat-messages">
	                              {chatMessagesError && <div className="alert mb-4">{chatMessagesError}</div>}
	                              {chatMessagesLoading ? (
	                                <div className="text-center text-muted text-sm py-6">{tr("loadingMessages")}</div>
	                              ) : chatMessages.length === 0 ? (
	                                <div className="text-center text-muted text-sm py-12">{tr("chatEmptyMessages")}</div>
	                              ) : (
	                                <div className="chat-message-list">
	                                  {chatMessages.map((m) => {
	                                    const role = String(m.role || "");
	                                    const isUser = role === "user";
	                                    const data = m.data as any;
	                                    const attachments = Array.isArray(data?.attachments) ? (data.attachments as any[]) : [];
	                                    const blocks = Array.isArray(data?.blocks) ? (data.blocks as any[]) : [];

	                                    return (
	                                      <div
	                                        key={m.id}
	                                        className={`chat-row ${isUser ? "right" : "left"}`}
	                                        data-testid={`chat-message-${m.id}`}
	                                      >
	                                        <div className={`chat-bubble ${isUser ? "user" : "assistant"}`}>
	                                          <div className="chat-meta">
	                                            <span className="mono">{role}</span>
	                                            <span className="chat-meta-sep">•</span>
	                                            <span className="mono">{formatTs(m.created_at_ms)}</span>
	                                          </div>

	                                          {m.content?.trim() && <div className="chat-text">{m.content}</div>}

	                                          {attachments.length > 0 && (
	                                            <div className="chat-attachments" data-testid="chat-message-attachments">
	                                              {attachments.map((a, idx) => {
	                                                const artifactId = typeof a?.artifact_id === "string" ? a.artifact_id : "";
	                                                const fileName = typeof a?.file_name === "string" ? a.file_name : "file";
	                                                const mime = typeof a?.mime === "string" ? a.mime : "";
	                                                const bytes = typeof a?.bytes === "number" ? a.bytes : 0;
	                                                const rawUrl = artifactId
	                                                  ? `/tool/projects/${view.projectId}/artifacts/${artifactId}/raw`
	                                                  : "";
	                                                const isImage =
	                                                  mime.startsWith("image/") ||
	                                                  !!fileName.toLowerCase().match(/\.(png|jpg|jpeg|webp|gif|svg)$/);
	                                                return (
	                                                  <a
	                                                    key={`${artifactId}-${idx}`}
	                                                    className="attachment-chip"
	                                                    href={rawUrl || undefined}
	                                                    target={rawUrl ? "_blank" : undefined}
	                                                    rel="noreferrer"
	                                                  >
	                                                    {isImage && rawUrl ? (
	                                                      <img className="attachment-thumb" src={rawUrl} alt={fileName} />
	                                                    ) : (
	                                                      <div className="attachment-icon" aria-hidden>
	                                                        FILE
	                                                      </div>
	                                                    )}
	                                                    <div className="attachment-body">
	                                                      <div className="attachment-name">{fileName}</div>
	                                                      <div className="attachment-meta mono">{bytesToSize(bytes)}</div>
	                                                    </div>
	                                                  </a>
	                                                );
	                                              })}
	                                            </div>
	                                          )}

	                                          {blocks.map((b, idx) => {
	                                            const type = String(b?.type || "");
	                                            if (type === "prompt") {
	                                              const title = typeof b?.title === "string" ? b.title : "Prompt";
	                                              const text = typeof b?.text === "string" ? b.text : "";
	                                              if (!text) return null;
	                                              return (
	                                                <div key={`b-${idx}`} className="chat-block">
	                                                  <div className="chat-block-title">{title}</div>
	                                                  <div className="code-block text-xs">{text}</div>
	                                                </div>
	                                              );
	                                            }
	                                            if (type === "videos") {
	                                              const videos = Array.isArray(b?.videos) ? (b.videos as any[]) : [];
	                                              if (videos.length === 0) return null;
	                                              return (
	                                                <div key={`b-${idx}`} className="chat-block">
	                                                  <div className="video-cards">
	                                                    {videos.map((v, vi) => {
	                                                      const url = typeof v?.url === "string" ? v.url : "";
	                                                      const title = typeof v?.title === "string" ? v.title : url;
	                                                      const desc = typeof v?.description === "string" ? v.description : null;
	                                                      const thumb = typeof v?.thumbnail === "string" ? v.thumbnail : null;
	                                                      const busy = chatCardBusyUrl === url;
	                                                      return (
	                                                        <div key={`${url}-${vi}`} className="video-card" data-testid="chat-video-card">
	                                                          {thumb ? (
	                                                            <img className="video-thumb" src={thumb} alt="" />
	                                                          ) : (
	                                                            <div className="video-thumb placeholder" />
	                                                          )}
	                                                          <div className="video-info">
	                                                            <a className="video-title" href={url} target="_blank" rel="noreferrer">
	                                                              {title}
	                                                            </a>
	                                                            {desc ? <div className="video-desc">{desc}</div> : null}
	                                                            <div className="video-url mono">{url}</div>
	                                                            <div className="video-actions">
	                                                              <button
	                                                                className="btn btn-secondary btn-sm"
	                                                                type="button"
	                                                                onClick={() => void onChatCardResolveOrDownload(url, false)}
	                                                                disabled={!url || busy}
	                                                              >
	                                                                {busy ? "…" : tr("resolve")}
	                                                              </button>
	                                                              <button
	                                                                className="btn btn-secondary btn-sm"
	                                                                type="button"
	                                                                onClick={() => void onChatCardResolveOrDownload(url, true)}
	                                                                disabled={!url || busy || (toolHealth ? !toolHealth.ffmpeg : false)}
	                                                                title={toolHealth && !toolHealth.ffmpeg ? tr("errFfmpegRequiredForDownload") : undefined}
	                                                              >
	                                                                {busy ? "…" : tr("downloadNow")}
	                                                              </button>
	                                                            </div>
	                                                          </div>
	                                                        </div>
	                                                      );
	                                                    })}
	                                                  </div>
	                                                </div>
	                                              );
	                                            }
	                                            return null;
	                                          })}
	                                        </div>
	                                      </div>
	                                    );
	                                  })}
	                                </div>
	                              )}
	                              <div ref={chatEndRef} />
	                            </div>

	                            {chatCardError && <div className="alert mt-4">{chatCardError}</div>}
	                            {chatUploadError && <div className="alert mt-4">{chatUploadError}</div>}
	                            {chatSendError && <div className="alert mt-4">{chatSendError}</div>}

	                            {chatAttachments.length > 0 && (
	                              <div className="chat-attachments" data-testid="chat-attachments">
	                                {chatAttachments.map((a) => {
	                                  const rawUrl = `/tool/projects/${view.projectId}/artifacts/${a.artifact.id}/raw`;
	                                  const isImage =
	                                    (a.mime || "").startsWith("image/") ||
	                                    !!a.file_name.toLowerCase().match(/\.(png|jpg|jpeg|webp|gif|svg)$/);
	                                  return (
	                                    <div key={a.artifact.id} className="attachment-chip attachment-pending">
	                                      {isImage ? (
	                                        <img className="attachment-thumb" src={rawUrl} alt={a.file_name} />
	                                      ) : (
	                                        <div className="attachment-icon" aria-hidden>
	                                          FILE
	                                        </div>
	                                      )}
	                                      <div className="attachment-body">
	                                        <div className="attachment-name">{a.file_name}</div>
	                                        <div className="attachment-meta mono">{bytesToSize(a.bytes)}</div>
	                                      </div>
	                                      <button
	                                        className="btn btn-ghost btn-sm"
	                                        type="button"
	                                        onClick={() => onChatRemoveAttachment(a.artifact.id)}
	                                        data-testid={`chat-remove-attachment-${a.artifact.id}`}
	                                      >
	                                        ×
	                                      </button>
	                                    </div>
	                                  );
	                                })}
	                              </div>
	                            )}

	                            <div className="chat-composer" data-testid="chat-composer">
	                              <input
	                                ref={chatFileInputRef}
	                                type="file"
	                                hidden
	                                multiple
	                                onChange={(e) => void onChatUploadFiles(e.target.files)}
	                                data-testid="chat-file-input"
	                              />
	                              <button
	                                className="btn btn-secondary btn-sm"
	                                type="button"
	                                onClick={() => chatFileInputRef.current?.click()}
	                                disabled={chatUploadBusy}
	                                data-testid="chat-upload"
	                              >
	                                {chatUploadBusy ? "…" : tr("upload")}
	                              </button>
	                              <textarea
	                                className="input-field chat-textarea"
	                                placeholder={tr("chatPlaceholder")}
	                                value={chatDraft}
	                                onChange={(e) => setChatDraft(e.target.value)}
	                                onKeyDown={(e) => {
	                                  if (e.key !== "Enter") return;
	                                  if (e.shiftKey) return;
	                                  if ((e.nativeEvent as any)?.isComposing) return;
	                                  e.preventDefault();
	                                  void onChatSend();
	                                }}
	                                disabled={chatSendBusy}
	                                data-testid="chat-input"
	                              />
	                              <button
	                                className="btn btn-primary btn-sm"
	                                type="button"
	                                onClick={() => void onChatSend()}
	                                disabled={chatSendBusy}
	                                data-testid="chat-send"
	                              >
	                                {chatSendBusy ? tr("sending") : tr("send")}
	                              </button>
	                            </div>

	                            <div className="text-xs text-muted mt-2">{tr("chatHint")}</div>
	                          </div>
	                        </div>
	                      </div>
	                    ) : (
	                      <div className="flex flex-col gap-6">
                      
                      {/* Analysis Section */}
                      <div className="panel">
                         <div className="panel-header">
                           <div className="panel-title">{tr("analysis")}</div>
                         </div>
                         
                         <div className="flex gap-4 mb-4">
                            <div className="flex-1">
                              <label className="input-label">{tr("modelIdPlaceholder")}</label>
                              <input
                                 className="input-field"
                                 placeholder="gemini-2.0-flash-exp"
                                 value={analysisModel}
                                 onChange={(e) => setAnalysisModel(e.target.value)}
                                 disabled={analysisBusy}
                              />
                            </div>
                            <div className="flex-1">
                              <label className="input-label">{tr("localVideo")}</label>
                              <select
                                 className="input-field"
                                 value={analysisVideoArtifactId}
                                 onChange={(e) => setAnalysisVideoArtifactId(e.target.value)}
                                 disabled={analysisBusy || inputVideos.length === 0}
                              >
                                 {inputVideos.length === 0 ? <option value="">{tr("noVideoAvailable")}</option> : inputVideos.map(v => (
                                   <option key={v.id} value={v.id}>{v.path}</option>
                                 ))}
                              </select>
                            </div>
                            <div className="flex-none self-end">
                              <button className="btn btn-primary" onClick={() => void onRunAnalysis()} disabled={analysisBusy} data-testid="run-analysis">
                                {analysisBusy ? tr("analyzing") : tr("runAnalysis")}
                              </button>
                            </div>
                         </div>
                         
                         {analysisError && <div className="alert mb-4">{analysisError}</div>}
                         
                         {(analysisText || analysisParsed) ? (
                           <div className="code-block">
                              {analysisParsed ? JSON.stringify(analysisParsed, null, 2) : analysisText}
                           </div>
                         ) : (
                           <div className="text-center text-muted text-sm py-12 border-2 border-dashed border-base rounded-lg bg-input">
                             {tr("analysisPlaceholder")}
                           </div>
                         )}

                          {(settings?.think_enabled ?? true) && lastPlan != null && (
                            <div className="mt-6">
                               <div className="text-xs font-bold text-muted uppercase mb-2">{tr("latestPlan")}</div>
                               <div className="code-block text-xs">{JSON.stringify(lastPlan, null, 2)}</div>
                            </div>
                          )}
                      </div>

                      {/* Context Search Section */}
                      <div className="panel">
                          <div className="panel-header">
                             <div className="panel-title">{tr("contextSearch")}</div>
                             <div className="text-xs mono text-dim">{tr("usageStats", { exa: exaSearchCount, fetch: webFetchCount })}</div>
                          </div>
                          
                          <div className="flex gap-3 mb-6">
                             <input 
                               type="text"
                               className="flex-1 input-field"
                               placeholder={tr("searchQueryPlaceholder")}
                               value={exaQuery}
                               onChange={e => setExaQuery(e.target.value)}
                               disabled={exaBusy || fetchBusy}
                             />
                             <button className="btn btn-secondary" onClick={() => void onExaSearch()} disabled={exaBusy || fetchBusy}>
                                {exaBusy ? tr("searching") : tr("search")}
                             </button>
                          </div>
                          
                          {exaError && <div className="alert mb-4">{exaError}</div>}

                          {exaResults.length > 0 ? (
                            <div className="border border-base rounded-lg overflow-hidden">
                              {exaResults.map((r, i) => (
                                <div key={i} className="p-4 border-b border-base last:border-0 hover:bg-black/5 flex gap-4 justify-between items-center transition-colors">
                                  <div className="flex-1 overflow-hidden">
                                    <div className="text-base font-medium text-main truncate" title={r.title}>{r.title || tr("untitled")}</div>
                                    <a href={r.url} target="_blank" rel="noopener" className="text-xs mono text-primary truncate block mt-1 hover:underline">{r.url}</a>
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
                          ) : (
                             <div className="text-center text-muted text-sm py-8">{tr("noResults")}</div>
                          )}

                          {fetchUrl && (
                            <div className="mt-6">
                               <div className="text-xs font-bold text-muted uppercase mb-2">{tr("fetched", { url: fetchUrl })}</div>
                               {fetchError ? <div className="text-error text-xs">{fetchError}</div> : 
                                fetchRaw ? <div className="code-block text-xs h-64">{JSON.stringify(fetchRaw, null, 2)}</div> : null}
                            </div>
                          )}
                       </div>

                       {/* Asset Pool Section */}
                       <div className="panel">
                          <div className="panel-header">
                             <div className="panel-title">{tr("assetPool")}</div>
                             <div className="text-xs mono text-dim">{tr("selected", { count: poolSelectedCount })}</div>
                          </div>
                          
                          {poolItems.length === 0 ? (
                             <div className="text-center text-muted text-sm py-12 bg-input rounded-lg border border-dashed border-base">
                                {tr("noItemsInPool")}
                             </div>
                          ) : (
                             <div className="grid grid-cols-1 gap-0 border border-base rounded-lg overflow-hidden">
                               {poolItems.map(item => (
                                 <div key={item.id} className="p-3 bg-surface border-b border-base last:border-0 hover:bg-black/5 flex gap-3 items-center">
                                    <div className="pt-1">
                                       <input
                                          type="checkbox"
                                          className="accent-primary"
                                          checked={item.selected}
                                          onChange={(e) => void onTogglePoolSelected(item.id, e.target.checked)}
                                       />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                       <div className="text-sm font-medium text-main truncate" title={item.title || ""}>{item.title || tr("untitled")}</div>
                                       <div className="text-xs mono text-muted truncate" title={item.source_url || ""}>{item.source_url || item.kind}</div>
                                    </div>
                                    <div className="text-xs text-dim whitespace-nowrap">
                                       {formatTs(item.created_at_ms)}
                                    </div>
                                 </div>
                               ))}
                             </div>
                          )}
                       </div>

	                    </div>
	                    )}
	                  </main>
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
