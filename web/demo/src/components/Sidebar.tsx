import { useState, useEffect, useCallback, useMemo } from "react";
import { TreeView, TreeViewItem, TreeViewItemContent, Collection, Text } from "@react-spectrum/s2";
// @ts-ignore
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Code from "@react-spectrum/s2/icons/Code";
import FileText from "@react-spectrum/s2/icons/FileText";
import File from "@react-spectrum/s2/icons/File";
import Folder from "@react-spectrum/s2/icons/Folder";
import * as runtime from "../vm/runtime";
import type { Key } from "@react-types/shared";

interface TreeNode {
  id: string;
  name: string;
  type: "file" | "dir" | "symlink";
  children?: TreeNode[];
}

interface SidebarProps {
  onFileOpen: (path: string) => void;
  activeFile: string | null;
}

const sidebarStyles = style({
  height: "full",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
}) as unknown as string;

const headerStyles = style({
  paddingX: 24,
  paddingTop: 12,
  paddingBottom: 8,
  fontFamily: "sans",
  fontSize: "ui-xs",
  fontWeight: "bold",
  color: "gray-600",
  textTransform: "uppercase",
}) as unknown as string;

function getFileIcon(name: string) {
  if (/\.(js|ts|jsx|tsx)$/.test(name)) return <Code />;
  if (/\.json$/.test(name)) return <FileText />;
  return <File />;
}

async function buildTree(path: string): Promise<TreeNode[]> {
  const entries = await runtime.listDir(path);
  if (!entries) return [];

  const sorted = [...entries].sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  const nodes: TreeNode[] = [];
  for (const entry of sorted) {
    const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    const node: TreeNode = {
      id: childPath,
      name: entry.name,
      type: entry.type,
    };
    if (entry.type === "dir") {
      node.children = await buildTree(childPath);
    }
    nodes.push(node);
  }
  return nodes;
}

export default function Sidebar({ onFileOpen, activeFile }: SidebarProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    new Set(["/examples", "/examples/01-basic", "/examples/02-advanced", "/examples/03-real-apps"])
  );

  useEffect(() => {
    buildTree("/examples").then(setTree);
  }, []);

  const selectedKeys = useMemo(
    () => (activeFile ? new Set<string>([activeFile]) : new Set<string>()),
    [activeFile]
  );

  const handleAction = useCallback(
    (key: Key) => {
      const path = String(key);
      const node = findNode(tree, path);
      if (!node) return;

      if (node.type === "dir") {
        setExpandedKeys((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      } else {
        onFileOpen(path);
      }
    },
    [tree, onFileOpen]
  );

  function renderItem(node: TreeNode) {
    const isDir = node.type === "dir";
    return (
      <TreeViewItem
        key={node.id}
        id={node.id}
        textValue={node.name}
        hasChildItems={isDir}
      >
        <TreeViewItemContent>
          {isDir ? <Folder /> : getFileIcon(node.name)}
          <Text>{node.name}</Text>
        </TreeViewItemContent>
        {isDir && node.children && (
          <Collection items={node.children}>
            {renderItem}
          </Collection>
        )}
      </TreeViewItem>
    );
  }

  return (
    <div className={sidebarStyles}>
      <div className={headerStyles}>Files</div>
      <TreeView
        aria-label="File tree"
        selectionMode="none"
        expandedKeys={expandedKeys}
        onExpandedChange={setExpandedKeys as any}
        onAction={handleAction}
      >
        <Collection items={tree}>
          {renderItem}
        </Collection>
      </TreeView>
    </div>
  );
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}
