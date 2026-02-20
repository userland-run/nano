import { useState, useEffect, useCallback } from "react";
import * as runtime from "../vm/runtime";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  children?: TreeNode[];
}

interface FileTreeProps {
  onFileOpen: (path: string) => void;
  activeFile: string | null;
}

export default function FileTree({ onFileOpen, activeFile }: FileTreeProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["/examples", "/examples/01-basic", "/examples/02-advanced", "/examples/03-real-apps"])
  );

  useEffect(() => {
    loadTree();
  }, []);

  const loadTree = useCallback(async () => {
    const root = await buildTree("/examples");
    if (root) setTree(root);
  }, []);

  return (
    <div className="filetree">
      <div className="filetree-header">Examples</div>
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          activeFile={activeFile}
          onToggle={(path) => {
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onFileOpen={onFileOpen}
        />
      ))}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  expanded,
  activeFile,
  onToggle,
  onFileOpen,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activeFile: string | null;
  onToggle: (path: string) => void;
  onFileOpen: (path: string) => void;
}) {
  const isDir = node.type === "dir";
  const isOpen = expanded.has(node.path);
  const isActive = activeFile === node.path;

  const icon = isDir ? (isOpen ? "\u25BE" : "\u25B8") : getFileIcon(node.name);

  return (
    <>
      <div
        className={`filetree-item${isActive ? " active" : ""}`}
        style={{ "--depth": depth } as React.CSSProperties}
        onClick={() => {
          if (isDir) onToggle(node.path);
          else onFileOpen(node.path);
        }}
      >
        <span className="filetree-icon">{icon}</span>
        <span className="filetree-name">{node.name}</span>
      </div>
      {isDir && isOpen && node.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          activeFile={activeFile}
          onToggle={onToggle}
          onFileOpen={onFileOpen}
        />
      ))}
    </>
  );
}

function getFileIcon(name: string): string {
  if (name.endsWith(".js")) return "\u{1F4DC}";
  if (name.endsWith(".json")) return "\u{1F4CB}";
  if (name.endsWith(".html")) return "\u{1F310}";
  if (name.endsWith(".css")) return "\u{1F3A8}";
  return "\u{1F4C4}";
}

async function buildTree(path: string): Promise<TreeNode[] | null> {
  const entries = await runtime.listDir(path);
  if (!entries) return null;

  const nodes: TreeNode[] = [];
  // Sort: dirs first, then files, alphabetical
  const sorted = [...entries].sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    const node: TreeNode = {
      name: entry.name,
      path: childPath,
      type: entry.type,
      size: entry.size,
    };

    if (entry.type === "dir") {
      node.children = await buildTree(childPath) || [];
    }

    nodes.push(node);
  }

  return nodes;
}
