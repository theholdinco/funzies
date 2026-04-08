"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
]);

const ALLOWED_EXTENSIONS = new Set([
  "txt", "md", "csv", "json", "xml", "html", "css", "js", "ts", "tsx", "jsx",
  "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "sh", "yaml", "yml",
  "toml", "sql", "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg",
  "gif", "webp", "svg",
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export interface AttachedFile {
  file: File;
  id: string;
  thumbnailUrl?: string;
}

export interface AttachmentWidgetHandle {
  openPicker: () => void;
  addFiles: (files: FileList | File[]) => void;
}

interface AttachmentWidgetProps {
  files: AttachedFile[];
  onChange: (files: AttachedFile[]) => void;
  disabled?: boolean;
  hideButton?: boolean;
  handleRef?: (handle: AttachmentWidgetHandle) => void;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp"].includes(ext)) return "\u{1F4C4}";
  if (["json", "xml", "yaml", "yml", "toml"].includes(ext)) return "\u2699";
  if (["md", "txt", "csv"].includes(ext)) return "\u{1F4DD}";
  if (["pdf", "doc", "docx"].includes(ext)) return "\u{1F4D1}";
  if (["xls", "xlsx"].includes(ext)) return "\u{1F4CA}";
  return "\u{1F4CE}";
}

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) return `${file.name} exceeds 20MB limit`;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(ext)) return `${file.name}: unsupported file type`;
  return null;
}

export default function AttachmentWidget({ files, onChange, disabled, hideButton, handleRef }: AttachmentWidgetProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const newFiles: AttachedFile[] = [];
    for (const file of Array.from(fileList)) {
      const error = validateFile(file);
      if (error) {
        console.warn(error);
        continue;
      }
      const attached: AttachedFile = {
        file,
        id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      };
      if (IMAGE_TYPES.has(file.type)) {
        attached.thumbnailUrl = URL.createObjectURL(file);
      }
      newFiles.push(attached);
    }
    if (newFiles.length > 0) onChange([...files, ...newFiles]);
  }, [files, onChange]);

  function handleRemove(id: string) {
    const removed = files.find((f) => f.id === id);
    if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
    onChange(files.filter((f) => f.id !== id));
  }

  useEffect(() => {
    if (handleRef) {
      handleRef({ openPicker: () => inputRef.current?.click(), addFiles });
    }
  }, [handleRef, addFiles]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!disabled && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  return (
    <div
      className={`attachment-wrapper${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {files.length > 0 && (
        <div className="attachment-chips">
          {files.map((f) => (
            <span key={f.id} className="attachment-chip">
              {f.thumbnailUrl ? (
                <img src={f.thumbnailUrl} alt="" className="attachment-chip-thumb" />
              ) : (
                <span className="attachment-chip-icon">{fileIcon(f.file.name)}</span>
              )}
              <span className="attachment-chip-name">{f.file.name}</span>
              <button
                className="attachment-chip-remove"
                onClick={() => handleRemove(f.id)}
                disabled={disabled}
                title="Remove"
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        accept={[...ALLOWED_EXTENSIONS].map((e) => `.${e}`).join(",")}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {!hideButton && (
        <button
          type="button"
          className="attachment-btn"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          title="Attach files"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 8.5l-5.5 5.5a4 4 0 01-5.66-5.66l7.08-7.07a2.67 2.67 0 013.77 3.77L6.6 12.1a1.33 1.33 0 01-1.88-1.88L11 3.94" />
          </svg>
          Attach
        </button>
      )}
    </div>
  );
}
