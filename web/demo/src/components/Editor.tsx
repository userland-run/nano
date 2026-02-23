import { useEffect, useRef, useCallback } from "react";
import { Text, Heading, Content, IllustratedMessage } from "@react-spectrum/s2";
// @ts-ignore
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Code from "@react-spectrum/s2/icons/Code";
import FileText from "@react-spectrum/s2/icons/FileText";
import File from "@react-spectrum/s2/icons/File";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";

interface EditorProps {
  path: string | null;
  content: string;
  onSave: (path: string, content: string) => void;
}

const containerStyles = style({
  flexGrow: 1,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
}) as unknown as string;

// Panel header for editor tab: consistent with output panel header
const tabBarStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 48,
  paddingX: 24,
  flexShrink: 0,
}) as unknown as string;

const bodyStyles = style({
  flexGrow: 1,
  overflow: "hidden",
}) as unknown as string;

const emptyStyles = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "full",
}) as unknown as string;

function getFileIcon(name: string) {
  if (/\.(js|ts|jsx|tsx)$/.test(name)) return <Code />;
  if (/\.json$/.test(name)) return <FileText />;
  return <File />;
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
    <div className={containerStyles}>
      <div className={tabBarStyles}>
        {fileName ? (
          <>
            {getFileIcon(fileName)}
            <Text styles={style({ fontSize: "body-sm", fontWeight: "medium", fontFamily: "code" })}>{fileName}</Text>
          </>
        ) : null}
      </div>
      <div className={bodyStyles} ref={containerRef} style={path ? { backgroundColor: '#282c34' } : undefined}>
        {!path && (
          <div className={emptyStyles}>
            <IllustratedMessage>
              <Heading>No file open</Heading>
              <Content>Select a file from the sidebar to start editing</Content>
            </IllustratedMessage>
          </div>
        )}
      </div>
    </div>
  );
}
