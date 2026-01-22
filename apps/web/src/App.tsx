import React from "react";

type OrchestratorHealth = { ok: boolean; service?: string };
type ToolserverHealth = { ok: boolean; service: string; ffmpeg: boolean; data_dir: string; db_path: string };

type Project = { id: string; title: string; created_at_ms: number };
type Consent = { project_id: string; consented: boolean; auto_confirm: boolean; updated_at_ms: number };
type Artifact = { id: string; project_id: string; kind: string; path: string; created_at_ms: number };
type ImportLocalResponse = { artifact: Artifact; bytes: number; file_name: string };

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
  const [artifacts, setArtifacts] = React.useState<Artifact[]>([]);
  const [projectError, setProjectError] = React.useState<string | null>(null);
  const [projectLoading, setProjectLoading] = React.useState(false);

  const [localFile, setLocalFile] = React.useState<File | null>(null);
  const [importBusy, setImportBusy] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);

  const [inputUrl, setInputUrl] = React.useState("");
  const [saveUrlBusy, setSaveUrlBusy] = React.useState(false);
  const [saveUrlError, setSaveUrlError] = React.useState<string | null>(null);

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
      const [p, c, a] = await Promise.all([
        fetchJson<Project>(`/tool/projects/${projectId}`),
        fetchJson<Consent>(`/tool/projects/${projectId}/consent`),
        fetchJson<Artifact[]>(`/tool/projects/${projectId}/artifacts`),
      ]);
      setProject(p);
      setConsent(c);
      setArtifacts(a);
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
    setArtifacts([]);
    setProjectError(null);
    setLocalFile(null);
    setImportError(null);
    setInputUrl("");
    setSaveUrlError(null);
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
      setSaveUrlError("请输入 URL");
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

  return (
    <div className="app">
      <header className="header">
        <h1>VidUnpack</h1>
        <p className="subtitle">视频拆解箱（MVP）</p>
      </header>

      <section className="card">
        <div className="row row-between row-center">
          <h2>Services</h2>
          <button className="btn btn-secondary" onClick={refreshHealth}>
            Refresh
          </button>
        </div>
        {healthError ? (
          <p className="error">{healthError}</p>
        ) : (
          <div className="grid grid-2">
            <div className="pill">
              <div className="pill-title">orchestrator</div>
              <div className={orchHealth?.ok ? "ok" : "muted"}>{orchHealth?.ok ? "ok" : "…"}</div>
            </div>
            <div className="pill">
              <div className="pill-title">toolserver</div>
              <div className={toolHealth?.ok ? "ok" : "muted"}>
                {toolHealth?.ok ? `ok (ffmpeg=${toolHealth.ffmpeg ? "true" : "false"})` : "…"}
              </div>
            </div>
          </div>
        )}
      </section>

      {view.kind === "list" ? (
        <section className="card">
          <div className="row row-between row-center">
            <h2>Projects</h2>
            <button className="btn btn-secondary" onClick={refreshProjects} disabled={projectsLoading}>
              Refresh
            </button>
          </div>

          <div className="row row-gap">
            <input
              className="input"
              placeholder="New project title (optional)"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              disabled={createBusy}
            />
            <button className="btn" onClick={onCreateProject} disabled={createBusy}>
              {createBusy ? "Creating…" : "Create"}
            </button>
          </div>

          {projectsError ? <p className="error">{projectsError}</p> : null}
          {projectsLoading ? (
            <p className="muted">loading…</p>
          ) : projects.length === 0 ? (
            <p className="muted">No projects yet.</p>
          ) : (
            <div className="table">
              <div className="table-row table-head">
                <div>Title</div>
                <div>Created</div>
                <div />
              </div>
              {projects.map((p) => (
                <div key={p.id} className="table-row">
                  <div className="mono">{p.title || "(untitled)"}</div>
                  <div className="muted">{formatTs(p.created_at_ms)}</div>
                  <div className="right">
                    <button className="btn btn-secondary" onClick={() => onOpenProject(p.id)}>
                      Open
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <div className="row row-between row-center">
            <div>
              <h2>Project</h2>
              <div className="muted mono">{view.projectId}</div>
            </div>
            <button className="btn btn-secondary" onClick={onBackToList}>
              Back
            </button>
          </div>

          {projectLoading ? (
            <p className="muted">loading…</p>
          ) : projectError ? (
            <p className="error">{projectError}</p>
          ) : project ? (
            <div className="grid grid-2">
              <div className="pill">
                <div className="pill-title">Title</div>
                <div className="mono">{project.title || "(untitled)"}</div>
              </div>
              <div className="pill">
                <div className="pill-title">Created</div>
                <div className="mono">{formatTs(project.created_at_ms)}</div>
              </div>
            </div>
          ) : null}

          <div className="divider" />

          <h3>Consent (project-scoped)</h3>
          <p className="muted">
            对外部链接的视频下载/解析可能涉及版权、平台条款或其他合规风险。我们会在每个项目里让你确认一次。
          </p>
          <div className="row row-between row-center">
            <div className="mono">
              consented: <span className={consent?.consented ? "ok" : "warn"}>{consent?.consented ? "true" : "false"}</span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!consent?.auto_confirm}
                onChange={(e) => void onToggleAutoConfirm(e.target.checked)}
                disabled={!consent?.consented}
              />
              <span>以后自动确认（本项目）</span>
            </label>
          </div>

          <div className="divider" />

          <h3>Import local video</h3>
          <div className="row row-gap">
            <input
              className="input"
              type="file"
              accept="video/*"
              onChange={(e) => setLocalFile(e.target.files?.item(0) || null)}
              disabled={importBusy}
            />
            <button className="btn" onClick={onImportLocal} disabled={importBusy || !localFile}>
              {importBusy ? "Importing…" : "Import"}
            </button>
          </div>
          {localFile ? <p className="muted">Selected: {localFile.name}</p> : null}
          {importError ? <p className="error">{importError}</p> : null}

          <div className="divider" />

          <h3>Paste video URL</h3>
          <div className="row row-gap">
            <input
              className="input"
              placeholder="https://..."
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              disabled={saveUrlBusy}
            />
            <button className="btn" onClick={onSaveUrl} disabled={saveUrlBusy}>
              {saveUrlBusy ? "Saving…" : "Save"}
            </button>
          </div>
          {saveUrlError ? <p className="error">{saveUrlError}</p> : null}

          <div className="divider" />

          <h3>Inputs</h3>
          <div className="grid grid-2">
            <div className="pill">
              <div className="pill-title">Local videos</div>
              {inputVideos.length === 0 ? (
                <div className="muted">none</div>
              ) : (
                <ul className="list">
                  {inputVideos.map((a) => (
                    <li key={a.id} className="mono">
                      {a.path}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="pill">
              <div className="pill-title">URLs</div>
              {inputUrls.length === 0 ? (
                <div className="muted">none</div>
              ) : (
                <ul className="list">
                  {inputUrls.map((a) => (
                    <li key={a.id} className="mono">
                      {a.path}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {consentModalOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>确认一次（本项目）</h3>
            <p className="muted">
              你即将保存一个外部链接，后续工作流可能会触发下载/解析。请确认你有权使用该内容，并愿意承担相应风险。
            </p>
            <div className="pill mono">{consentModalUrl}</div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={consentModalAutoConfirm}
                onChange={(e) => setConsentModalAutoConfirm(e.target.checked)}
                disabled={consentModalBusy}
              />
              <span>以后自动确认（本项目）</span>
            </label>
            {consentModalError ? <p className="error">{consentModalError}</p> : null}
            <div className="row row-right row-gap">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setConsentModalOpen(false);
                  setConsentModalUrl(null);
                  setConsentModalError(null);
                }}
                disabled={consentModalBusy}
              >
                Cancel
              </button>
              <button className="btn" onClick={() => void onConfirmConsentAndSaveUrl()} disabled={consentModalBusy}>
                {consentModalBusy ? "Confirming…" : "I confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
