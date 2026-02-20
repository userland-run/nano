import { useEffect, useRef, useCallback } from "react";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";

interface EditorProps {
  path: string | null;
  content: string;
  onSave: (path: string, content: string) => void;
}

export default function Editor({ path, content, onSave }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const handleSave = useCallback(() => {
    if (viewRef.current && pathRef.current) {
      const doc = viewRef.current.state.doc.toString();
      onSave(pathRef.current, doc);
    }
  }, [onSave]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous editor
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    if (!path) return;

    const view = new EditorView({
      doc: content,
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              handleSave();
              return true;
            },
          },
        ]),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [path, content, handleSave]);

  const fileName = path ? path.split("/").pop() : null;

  return (
    <div className="editor-container">
      <div className="editor-tab-bar">
        {fileName && (
          <div className="editor-tab active">{fileName}</div>
        )}
      </div>
      <div className="editor-body" ref={containerRef}>
        {!path && (
          <div className="editor-empty">Select a file to edit</div>
        )}
      </div>
    </div>
  );
}
