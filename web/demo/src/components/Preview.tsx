import type { RightPanelTab } from "../types";
import Terminal from "./Terminal";
import { useCallback } from "react";

interface PreviewProps {
  output: string[];
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  previewUrl: string | null;
}

export default function Preview({
  output,
  activeTab,
  onTabChange,
  previewUrl,
}: PreviewProps) {
  // No-op clear: we'd need to pass setOutput up. For now, just emit empty.
  const handleClear = useCallback(() => {
    // Output is managed by parent; this is a soft "clear"
  }, []);

  return (
    <div className="preview-container">
      <div className="preview-tabs">
        <div
          className={`preview-tab${activeTab === "console" ? " active" : ""}`}
          onClick={() => onTabChange("console")}
        >
          Console
        </div>
        <div
          className={`preview-tab${activeTab === "preview" ? " active" : ""}`}
          onClick={() => onTabChange("preview")}
        >
          Preview
        </div>
      </div>
      <div className="preview-body">
        {activeTab === "console" && (
          <Terminal output={output} onClear={handleClear} />
        )}
        {activeTab === "preview" && (
          previewUrl ? (
            <iframe
              className="preview-iframe"
              src={previewUrl}
              title="Preview"
            />
          ) : (
            <div className="preview-empty">
              No preview available. Run a server example to see output here.
            </div>
          )
        )}
      </div>
    </div>
  );
}
