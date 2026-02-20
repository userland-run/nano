import type { RuntimeMode } from "../types";

interface TopBarProps {
  runtimeMode: RuntimeMode;
  onRuntimeChange: (mode: RuntimeMode) => void;
  command: string;
  onCommandChange: (cmd: string) => void;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
  running: boolean;
}

export default function TopBar({
  runtimeMode,
  onRuntimeChange,
  command,
  onCommandChange,
  onRun,
  onStop,
  onReset,
  running,
}: TopBarProps) {
  return (
    <div className="topbar">
      <span className="topbar-logo">NanoVM</span>
      <select
        value={runtimeMode}
        onChange={(e) => onRuntimeChange(e.target.value as RuntimeMode)}
      >
        <option value="node">Node.js</option>
        <option value="busybox">BusyBox</option>
      </select>
      <input
        type="text"
        value={command}
        onChange={(e) => onCommandChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !running) onRun();
        }}
        placeholder={runtimeMode === "node" ? "node script.js" : "echo hello"}
      />
      {running ? (
        <button className="btn-stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="btn-run" onClick={onRun} disabled={!command.trim()}>
          Run
        </button>
      )}
      <button className="btn-reset" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}
