import { Tabs, TabList, Tab, TabPanel, Text, ActionButton, Heading, Content, IllustratedMessage } from "@react-spectrum/s2";
// @ts-ignore
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Code from "@react-spectrum/s2/icons/Code";
import Preview from "@react-spectrum/s2/icons/Preview";
import type { RightPanelTab } from "../types";
import Terminal from "./Terminal";
import type { Key } from "@react-types/shared";

interface OutputPanelProps {
  output: string[];
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  previewUrl: string | null;
  onClear: () => void;
}

const panelStyles = style({
  flexGrow: 1,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  position: "relative",
}) as unknown as string;

// Clear button floats over the tab header, right-aligned
const clearStyles = style({
  position: "absolute",
  top: 8,
  insetEnd: 16,
  zIndex: 1,
}) as unknown as string;

const tabContentStyles = style({
  flexGrow: 1,
  overflow: "hidden",
}) as unknown as string;

const emptyStyles = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "full",
}) as unknown as string;

export default function OutputPanel({
  output,
  activeTab,
  onTabChange,
  previewUrl,
  onClear,
}: OutputPanelProps) {
  return (
    <div className={panelStyles}>
      {activeTab === "console" && (
        <div className={clearStyles}>
          <ActionButton size="XS" isQuiet onPress={onClear}>
            Clear
          </ActionButton>
        </div>
      )}
      <Tabs
        aria-label="Output"
        selectedKey={activeTab}
        onSelectionChange={(key: Key | null) => {
          if (key) onTabChange(key as RightPanelTab);
        }}
        UNSAFE_style={{ paddingInline: '16px' }}
      >
        <TabList>
          <Tab id="console"><Code /><Text>Console</Text></Tab>
          <Tab id="preview"><Preview /><Text>Preview</Text></Tab>
        </TabList>
        <TabPanel id="console">
          <div className={tabContentStyles}>
            <Terminal output={output} />
          </div>
        </TabPanel>
        <TabPanel id="preview">
          <div className={tabContentStyles}>
            {previewUrl ? (
              <iframe
                style={{ width: "100%", height: "100%", border: "none", background: "white" }}
                src={previewUrl}
                title="Preview"
              />
            ) : (
              <div className={emptyStyles}>
                <IllustratedMessage>
                  <Heading>No preview</Heading>
                  <Content>Run a server example to see output here</Content>
                </IllustratedMessage>
              </div>
            )}
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
