import { useEffect, useRef } from "react";

interface TerminalProps {
  output: string[];
  onClear: () => void;
}

export default function Terminal({ output, onClear }: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <button className="terminal-clear" onClick={onClear}>
        Clear
      </button>
      <div className="terminal-wrapper" ref={scrollRef}>
        {output.length === 0 ? (
          <span style={{ color: "var(--text-muted)" }}>
            Press Run to execute...
          </span>
        ) : (
          output.join("")
        )}
      </div>
    </div>
  );
}
