"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingPage() {
  const [showGuide, setShowGuide] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const router = useRouter();
  const [trialAvailable, setTrialAvailable] = useState(false);

  useEffect(() => {
    fetch("/api/keys")
      .then((r) => r.json())
      .then((data) => {
        if (data.hasApiKey) {
          router.push("/");
          router.refresh();
        } else if (data.freeTrialAvailable) {
          setTrialAvailable(true);
        }
      })
      .catch(() => {});
  }, [router]);

  async function handleValidateAndStore() {
    if (!apiKey.trim()) return;
    setError("");
    setValidating(true);

    const validateRes = await fetch("/api/keys/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });

    const validateData = await validateRes.json();

    if (!validateData.valid) {
      setError(validateData.error || "Invalid API key. Please check and try again.");
      setValidating(false);
      return;
    }

    const storeRes = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });

    if (!storeRes.ok) {
      setError("Failed to store API key. Please try again.");
      setValidating(false);
      return;
    }

    setValidating(false);
    setSuccess(true);

    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 2000);
  }

  return (
    <div className="standalone-page">
      <div className="standalone-page-inner">
        <div className="standalone-header">
          <h1>Connect your Anthropic account</h1>
          <p>
            Million Minds uses Claude to generate debates. Paste your API key below.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div className="step-card active">
            <div className="step-card-body">
              {success ? (
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--color-high)" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span style={{ fontWeight: 500 }}>Key validated and stored securely!</span>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleValidateAndStore(); }}
                      placeholder="sk-ant-..."
                      className="form-field"
                      style={{
                        flex: 1,
                        padding: "0.65rem 0.85rem",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-sm)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.85rem",
                        background: "var(--color-bg)",
                      }}
                      disabled={validating}
                      autoFocus
                    />
                    <button
                      onClick={handleValidateAndStore}
                      disabled={validating || !apiKey.trim()}
                      className={`btn-primary ${validating || !apiKey.trim() ? "disabled" : ""}`}
                    >
                      {validating ? "Validating..." : "Connect"}
                    </button>
                  </div>
                  {error && (
                    <p style={{ color: "var(--color-low)", fontSize: "0.85rem" }}>{error}</p>
                  )}
                  <p style={{ color: "var(--color-text-muted)", fontSize: "0.8rem", marginTop: "0.5rem" }}>
                    Assemblies typically cost ~$0.50 in API credits. Your key is encrypted with AES-256-GCM.
                  </p>
                </>
              )}
            </div>
          </div>

          {!success && (
            <div style={{ textAlign: "center" }}>
              <button
                onClick={() => setShowGuide(!showGuide)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-text-muted)",
                  fontSize: "0.85rem",
                  padding: "0.25rem 0",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                }}
              >
                {showGuide ? "Hide guide" : "Don\u2019t have an API key?"}
              </button>

              {showGuide && (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1rem", textAlign: "left" }}>
                  <div className="step-card active">
                    <div className="step-card-header">
                      <div className="step-card-number">1</div>
                      <h3 className="step-card-title">Get an API key</h3>
                    </div>
                    <div className="step-card-body">
                      <p style={{ color: "var(--color-text-secondary)", marginBottom: "1rem" }}>
                        Go to the Anthropic Console and create an API key.
                      </p>
                      <a
                        href="https://console.anthropic.com/settings/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary"
                      >
                        Open Anthropic Console
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </a>
                    </div>
                  </div>

                  <div className="step-card active">
                    <div className="step-card-header">
                      <div className="step-card-number">2</div>
                      <h3 className="step-card-title">Click &quot;Create Key&quot;</h3>
                    </div>
                    <div className="step-card-body">
                      <p style={{ color: "var(--color-text-secondary)" }}>
                        Give the key a name (e.g. &quot;Million Minds&quot;) and copy it. Then paste it above.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {trialAvailable && !success && (
            <div style={{ textAlign: "center", marginTop: "0.5rem" }}>
              <button
                onClick={() => { router.push("/"); router.refresh(); }}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-text-muted)",
                  fontSize: "0.85rem",
                  padding: "0.25rem 0",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                }}
              >
                Skip — try a free panel first
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

