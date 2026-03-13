"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { Topic } from "@/lib/types";
export type AccessLevel = "owner" | "write" | "read" | null;

interface AssemblyContextValue {
  topic: Topic;
  assemblyId: string;
  accessLevel: AccessLevel;
  isFreeTrialAssembly: boolean;
  trialInteractionsUsed: number;
  refreshAssembly: () => Promise<void>;
}

const AssemblyContext = createContext<AssemblyContextValue | null>(null);

export function AssemblyProvider({
  topic: initialTopic,
  assemblyId,
  isComplete: initialIsComplete,
  accessLevel,
  isFreeTrialAssembly,
  trialInteractionsUsed: initialTrialInteractionsUsed,
  children,
}: {
  topic: Topic;
  assemblyId: string;
  isComplete?: boolean;
  accessLevel: AccessLevel;
  isFreeTrialAssembly: boolean;
  trialInteractionsUsed: number;
  children: React.ReactNode;
}) {
  const [topic, setTopic] = useState<Topic>(initialTopic);
  const [isComplete, setIsComplete] = useState(initialIsComplete ?? true);
  const [trialInteractionsUsed, setTrialInteractionsUsed] = useState(initialTrialInteractionsUsed);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/assemblies/${assemblyId}`);
      if (!res.ok) return;
      const row = await res.json();

      if (row.parsed_data) {
        setTopic((prev) => ({
          ...prev,
          ...row.parsed_data,
          // Preserve follow-ups from the layout's server query (they come from a separate table)
          followUps: prev.followUps,
        }));
      }

      if (typeof row.trial_interactions_used === "number") {
        setTrialInteractionsUsed(row.trial_interactions_used);
      }

      if (row.status === "complete" || row.status === "error" || row.status === "cancelled") {
        setIsComplete(true);
      }
    } catch {
      // Silently ignore poll failures
    }
  }, [assemblyId]);

  useEffect(() => {
    if (isComplete) return;

    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [isComplete, poll]);

  return (
    <AssemblyContext.Provider value={{ topic, assemblyId, accessLevel, isFreeTrialAssembly, trialInteractionsUsed, refreshAssembly: poll }}>
      {children}
    </AssemblyContext.Provider>
  );
}

export function useAssembly(): Topic {
  const ctx = useContext(AssemblyContext);
  if (!ctx) {
    throw new Error("useAssembly must be used within an AssemblyProvider");
  }
  return ctx.topic;
}

export function useRefreshAssembly(): () => Promise<void> {
  const ctx = useContext(AssemblyContext);
  if (!ctx) {
    throw new Error("useRefreshAssembly must be used within an AssemblyProvider");
  }
  return ctx.refreshAssembly;
}

export function useAssemblyId(): string {
  const ctx = useContext(AssemblyContext);
  if (!ctx) {
    throw new Error("useAssemblyId must be used within an AssemblyProvider");
  }
  return ctx.assemblyId;
}

export function useAssemblyAccess(): AccessLevel {
  const ctx = useContext(AssemblyContext);
  if (!ctx) {
    throw new Error("useAssemblyAccess must be used within an AssemblyProvider");
  }
  return ctx.accessLevel;
}

export function useAssemblyTrial(): { isFreeTrialAssembly: boolean; trialInteractionsUsed: number } {
  const ctx = useContext(AssemblyContext);
  if (!ctx) {
    throw new Error("useAssemblyTrial must be used within an AssemblyProvider");
  }
  return { isFreeTrialAssembly: ctx.isFreeTrialAssembly, trialInteractionsUsed: ctx.trialInteractionsUsed };
}
