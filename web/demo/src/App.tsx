import { useState, useEffect, useCallback, useRef } from "react";
import { Provider, ProgressCircle, Text, Heading } from "@react-spectrum/s2";
// @ts-ignore
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import "./allotment-overrides.css";
import Toolbar from "./components/Toolbar";
import Sidebar from "./components/Sidebar";
import Editor from "./components/Editor";
import OutputPanel from "./components/OutputPanel";
import { ensureVM } from "./vm/runtime";
import { loadExamples } from "./vm/examples";
import { registerServiceWorker } from "./vm/sw-bridge";
import * as runtime from "./vm/runtime";
import type { RuntimeMode, RightPanelTab, DemoManifest } from "./types";

// Layer 1: app shell background — visible as gutters between panels
const appStyles = style({
  display: "flex",
  flexDirection: "column",
  height: "screen",
  backgroundColor: "layer-1",
}) as unknown as string;

// Workspace: outer padding creates gutter around the edges
const bodyStyles = style({
  display: "flex",
  flexGrow: 1,
  overflow: "hidden",
  padding: 4,
}) as unknown as string;

// Floating panel base — absolute inset creates gutter revealing layer-1
const panelBase = {
  position: "absolute" as const,
  inset: 4,
  overflow: "hidden" as const,
  borderRadius: 8,
  display: "flex" as const,
  flexDirection: "column" as const,
  backgroundColor: "white",
};

// Main column fills its pane — contains nested vertical allotment
const mainColumnStyles = style({
  width: "full",
  height: "full",
}) as unknown as string;

const centerStyles = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "screen",
  gap: 16,
  backgroundColor: "layer-1",
  fontFamily: "sans",
}) as unknown as string;

const errorStyles = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "screen",
  gap: 16,
  padding: 32,
  textAlign: "center",
  backgroundColor: "layer-1",
  fontFamily: "sans",
}) as unknown as string;

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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const runAbortRef = useRef<(() => void) | null>(null);

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

  const handleRun = useCallback(async () => {
    if (running || !command.trim()) return;
    setRunning(true);
    setOutput([]);
    setPreviewUrl(null);
    setRightTab("console");

    let serverDetected = false;
    let fullOutput = "";

    const onStdout = (chunk: string) => {
      setOutput((prev) => [...prev, chunk]);
      fullOutput += chunk;

      if (!serverDetected && /listening/i.test(fullOutput)) {
        serverDetected = true;
        const portMatch = fullOutput.match(/(?:port\s+|:)(\d{2,5})/i);
        const port = portMatch ? parseInt(portMatch[1], 10) : 8080;
        console.log(`[app] Server detected on port ${port}, setting preview URL`);
        setPreviewUrl(`${import.meta.env.BASE_URL}sw/${port}/`);
        setRightTab("preview");
      }
    };

    const cmd = command.trim();
    let aborted = false;

    runAbortRef.current = () => { aborted = true; };

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
    if (runAbortRef.current) runAbortRef.current();

    setRunning(false);
    setPreviewUrl(null);
    setOutput((prev) => [...prev, "\n[stopped]\n"]);

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

  const handleClearOutput = useCallback(() => {
    setOutput([]);
  }, []);

  if (error) {
    return (
      <Provider locale="en-US">
        <div className={errorStyles}>
          <Heading level={2}>Failed to initialize nano</Heading>
          <Text>{error}</Text>
          <Text>Make sure you have built the container: <Text styles={style({ fontFamily: "code", fontSize: "code-sm" })}>make build</Text></Text>
        </div>
      </Provider>
    );
  }

  if (!ready) {
    return (
      <Provider locale="en-US">
        <div className={centerStyles}>
          <ProgressCircle aria-label="Loading nano..." isIndeterminate size="L" />
          <Text>Loading nano...</Text>
        </div>
      </Provider>
    );
  }

  return (
    <Provider locale="en-US">
      <div className={appStyles}>
        <Toolbar
          runtimeMode={runtimeMode}
          onRuntimeChange={setRuntimeMode}
          command={command}
          onCommandChange={setCommand}
          onRun={handleRun}
          onStop={handleStop}
          onReset={handleReset}
          running={running}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
        />
        <div className={bodyStyles}>
          <Allotment proportionalLayout={false} separator>
            {sidebarOpen && (
              <Allotment.Pane minSize={200} preferredSize={264} snap>
                <div style={panelBase}>
                  <Sidebar key={treeKey} onFileOpen={handleFileOpen} activeFile={openFile} />
                </div>
              </Allotment.Pane>
            )}
            <Allotment.Pane minSize={400}>
              <div className={mainColumnStyles}>
                <Allotment vertical proportionalLayout={false} separator>
                  <Allotment.Pane minSize={150}>
                    <div style={panelBase}>
                      <Editor
                        path={openFile}
                        content={fileContent}
                        onSave={handleSave}
                      />
                    </div>
                  </Allotment.Pane>
                  <Allotment.Pane minSize={120} preferredSize={280} snap>
                    <div style={panelBase}>
                      <OutputPanel
                        output={output}
                        activeTab={rightTab}
                        onTabChange={setRightTab}
                        previewUrl={previewUrl}
                        onClear={handleClearOutput}
                      />
                    </div>
                  </Allotment.Pane>
                </Allotment>
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
    </Provider>
  );
}
