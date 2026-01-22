import React from "react";

type Health = { ok: boolean; service?: string };

export default function App() {
  const [health, setHealth] = React.useState<Health | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Health;
        if (!cancelled) setHealth(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <header className="header">
        <h1>VidUnpack</h1>
        <p className="subtitle">视频拆解箱（MVP scaffold）</p>
      </header>

      <section className="card">
        <h2>Services</h2>
        {error ? (
          <p className="error">orchestrator: {error}</p>
        ) : health ? (
          <p className="ok">orchestrator: ok</p>
        ) : (
          <p className="muted">checking...</p>
        )}
      </section>
    </div>
  );
}

