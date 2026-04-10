// web/lib/clo/useMonteCarlo.ts
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ProjectionInputs } from "./projection";
import type { MonteCarloResult } from "./monte-carlo";
import type { MCWorkerOutbound } from "./monte-carlo.worker";

const MC_RUN_COUNT = 10_000;
const DEBOUNCE_MS = 500;

export function useMonteCarlo(inputs: ProjectionInputs | null) {
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createWorker = useCallback(() => {
    const worker = new Worker(
      new URL("./monte-carlo.worker.ts", import.meta.url)
    );

    worker.addEventListener("message", (event: MessageEvent<MCWorkerOutbound>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        setProgress(msg.completed / msg.total);
      } else if (msg.type === "result") {
        setResult({
          ...msg.data,
          irrs: new Float64Array(msg.data.irrs),
        });
        setRunning(false);
        setProgress(1);
      }
    });

    worker.addEventListener("error", () => {
      setRunning(false);
    });

    return worker;
  }, []);

  // Terminate and recreate worker to cancel in-flight runs
  const cancelAndRestart = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
    }
    workerRef.current = createWorker();
  }, [createWorker]);

  useEffect(() => {
    workerRef.current = createWorker();
    return () => {
      workerRef.current?.terminate();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [createWorker]);

  // Debounced auto-run when inputs change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!inputs) return;

    debounceRef.current = setTimeout(() => {
      cancelAndRestart();
      setRunning(true);
      setProgress(0);
      workerRef.current?.postMessage({
        type: "run",
        inputs,
        runCount: MC_RUN_COUNT,
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputs, cancelAndRestart]);

  return { result, running, progress };
}
