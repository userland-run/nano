import { useState, useEffect, useCallback, useRef } from "react";
import TopBar from "./components/TopBar";
import FileTree from "./components/FileTree";
import Editor from "./components/Editor";
import Preview from "./components/Preview";
import { ensureVM } from "./vm/runtime";
import { loadExamples } from "./vm/examples";
import { registerServiceWorker } from "./vm/sw-bridge";
import * as runtime from "./vm/runtime";
import type { RuntimeMode, RightPanelTab, DemoManifest } from "./types";

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("node");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [rightTab, setRightTab] = useState<RightPanelTab>("console");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [treeKey, setTreeKey] = useState(0);
  const runAbortRef = useRef<(() => void) | null>(null);

  // Initialize VM and load examples
  useEffect(() => {
    (async () => {
      try {
        const vm = await ensureVM();
        await loadExamples(vm);
        await registerServiceWorker();
        setReady(true);
        handleFileOpen("/examples/01-basic/hello.js");
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, []);

  const handleFileOpen = useCallback(async (path: string) => {
    setOpenFile(path);
    const content = await runtime.readFile(path);
    setFileContent(content || "");

    if (path.endsWith(".js")) {
      setCommand(runtimeMode === "node" ? `node ${path}` : path);
    } else if (path.endsWith(".json")) {
      try {
        const demo: DemoManifest = JSON.parse(content || "");
        setCommand(demo.command);
      } catch {}
    }
  }, [runtimeMode]);

  const handleSave = useCallback(async (path: string, content: string) => {
    await runtime.addFile(path, content);
    setFileContent(content);
  }, []);

  // Detect if the current file's directory has a demo.json with previewPort
  const getPreviewPort = useCallback(async (filePath: string): Promise<number | null> => {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    const manifest = await runtime.readFile(dir + "/demo.json");
    if (!manifest) return null;
    try {
      const demo: DemoManifest = JSON.parse(manifest);
      return demo.previewPort || null;
    } catch { return null; }
  }, []);

  const handleRun = useCallback(async () => {
    if (running || !command.trim()) return;
    setRunning(true);
    setOutput([]);
    setPreviewUrl(null);
    setRightTab("console");

    let serverDetected = false;

    const onStdout = (chunk: string) => {
      setOutput((prev) => [...prev, chunk]);

      // Auto-detect server start: look for "listening" in output
      if (!serverDetected && /listening/i.test(chunk)) {
        serverDetected = true;
        // Extract port from output like "port 8080" or ":8080"
        const portMatch = chunk.match(/(?:port\s+|:)(\d{2,5})/i);
        const port = portMatch ? parseInt(portMatch[1], 10) : 8080;
        setPreviewUrl(`${import.meta.env.BASE_URL}sw/${port}/`);
        setRightTab("preview");
      }
    };

    const cmd = command.trim();
    let aborted = false;

    // Store abort function so Stop can cancel
    runAbortRef.current = () => { aborted = true; };

    // Fire-and-forget: don't await, so the UI stays responsive
    // The VM step loop yields to the event loop, allowing SW messages to flow
    const runPromise = (async () => {
      try {
        let result;
        if (cmd.startsWith("node ")) {
          const args = cmd.slice(5).split(/\s+/);
          result = await runtime.runNode(args, { onStdout, maxSteps: 2_000_000_000 });
        } else {
          result = await runtime.runBusybox(cmd, { onStdout });
        }
        if (!aborted) {
          setOutput((prev) => [...prev, `\n[exit ${result.exitCode}]\n`]);
        }
      } catch (e: any) {
        if (!aborted) {
          setOutput((prev) => [...prev, `\nError: ${e.message}\n`]);
        }
      } finally {
        if (!aborted) {
          setRunning(false);
          setPreviewUrl(null);
        }
        runAbortRef.current = null;
      }
    })();
  }, [command, running]);

  const handleStop = useCallback(async () => {
    // Signal abort so the run callback doesn't update state
    if (runAbortRef.current) runAbortRef.current();

    setRunning(false);
    setPreviewUrl(null);
    setOutput((prev) => [...prev, "\n[stopped]\n"]);

    // Reset VM to kill the running process
    await runtime.resetVFS();
    const vm = await ensureVM();
    await loadExamples(vm);
    setTreeKey((k) => k + 1);
  }, []);

  const handleReset = useCallback(async () => {
    if (runAbortRef.current) runAbortRef.current();
    setRunning(false);
    setPreviewUrl(null);

    await runtime.resetVFS();
    const vm = await ensureVM();
    await loadExamples(vm);
    setTreeKey((k) => k + 1);
    setOutput([]);
    setOpenFile(null);
    setFileContent("");
  }, []);

  if (error) {
    return (
      <div className="app-error">
        <h2>Failed to initialize NanoVM</h2>
        <p>{error}</p>
        <p>Make sure you have built the container: <code>make container-full</code></p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="app-loading">
        <div className="spinner" />
        <p>Loading NanoVM...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        runtimeMode={runtimeMode}
        onRuntimeChange={setRuntimeMode}
        command={command}
        onCommandChange={setCommand}
        onRun={handleRun}
        onStop={handleStop}
        onReset={handleReset}
        running={running}
      />
      <div className="app-body">
        <div className="panel panel-left">
          <FileTree key={treeKey} onFileOpen={handleFileOpen} activeFile={openFile} />
        </div>
        <div className="panel panel-center">
          <Editor
            path={openFile}
            content={fileContent}
            onSave={handleSave}
          />
        </div>
        <div className="panel panel-right">
          <Preview
            output={output}
            activeTab={rightTab}
            onTabChange={setRightTab}
            previewUrl={previewUrl}
          />
        </div>
      </div>
    </div>
  );
}
