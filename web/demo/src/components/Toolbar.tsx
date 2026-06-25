// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of NanoVM; dual-licensed - see LICENSE.md.

import { ActionButton, Button, Picker, PickerItem, TextField, Text } from "@react-spectrum/s2";
// @ts-ignore
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import MenuHamburger from "@react-spectrum/s2/icons/MenuHamburger";
import Play from "@react-spectrum/s2/icons/Play";
import Close from "@react-spectrum/s2/icons/Close";
import Refresh from "@react-spectrum/s2/icons/Refresh";
import type { RuntimeMode } from "../types";
import type { Key } from "@react-types/shared";

interface ToolbarProps {
  runtimeMode: RuntimeMode;
  onRuntimeChange: (mode: RuntimeMode) => void;
  command: string;
  onCommandChange: (cmd: string) => void;
  onRun: () => void;
  onStop: () => void;
  onReset: () => void;
  running: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

const toolbarStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 16,
  paddingX: 24,
  height: "[56px]",
  backgroundColor: "base",
  flexShrink: 0,
}) as unknown as string;

// Fixed width: aligns with sidebar column below
// 264px sidebar + 8px body padding + 8px gap - 24px toolbar padding - 16px toolbar gap = 240px
const leftGroupStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexShrink: 0,
  width: "[240px]",
}) as unknown as string;

const centerGroupStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexGrow: 1,
}) as unknown as string;

const rightGroupStyles = style({
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexShrink: 0,
}) as unknown as string;

export default function Toolbar({
  runtimeMode,
  onRuntimeChange,
  command,
  onCommandChange,
  onRun,
  onStop,
  onReset,
  running,
  sidebarOpen,
  onToggleSidebar,
}: ToolbarProps) {
  return (
    <div className={toolbarStyles}>
      {/* Left: brand — fixed width aligned with sidebar column */}
      <div className={leftGroupStyles}>
        <ActionButton
          isQuiet
          size="S"
          onPress={onToggleSidebar}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          <MenuHamburger />
        </ActionButton>

        <Text
          styles={style({ fontWeight: "bold", fontSize: "body-lg", fontFamily: "code" })}
        >
          nano
        </Text>
      </div>

      {/* Center: runtime picker + command input — aligned with main column */}
      <div
        className={centerGroupStyles}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !running) onRun();
        }}
      >
        <Picker
          aria-label="Runtime"
          selectedKey={runtimeMode}
          onSelectionChange={(key: Key | null) => {
            if (key) onRuntimeChange(key as RuntimeMode);
          }}
          size="S"
          isQuiet
        >
          <PickerItem id="node">Node.js</PickerItem>
          <PickerItem id="busybox">BusyBox</PickerItem>
        </Picker>

        <TextField
          aria-label="Command"
          value={command}
          onChange={onCommandChange}
          placeholder={runtimeMode === "node" ? "node script.js" : "echo hello"}
          size="S"
          styles={style({ width: "full" })}
        />
      </div>

      {/* Right: primary action + secondary */}
      <div className={rightGroupStyles}>
        {running ? (
          <Button variant="negative" size="S" onPress={onStop}>
            <Close />
            <Text>Stop</Text>
          </Button>
        ) : (
          <Button variant="accent" size="S" onPress={onRun} isDisabled={!command.trim()}>
            <Play />
            <Text>Run</Text>
          </Button>
        )}

        <ActionButton isQuiet size="S" onPress={onReset} aria-label="Reset">
          <Refresh />
        </ActionButton>
      </div>
    </div>
  );
}
