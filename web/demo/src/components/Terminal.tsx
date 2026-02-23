import { useEffect, useRef } from "react";
import { Text } from "@react-spectrum/s2";
// @ts-ignore
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

interface TerminalProps {
  output: string[];
}

const scrollStyles = style({
  height: "full",
  paddingX: 8,
  paddingY: 16,
  overflow: "auto",
  fontFamily: "code",
  fontSize: "code-sm",
  lineHeight: "body",
  whiteSpace: "pre-wrap",
  color: "body",
}) as unknown as string;

export default function Terminal({ output }: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <div className={scrollStyles} ref={scrollRef}>
      {output.length === 0 ? (
        <Text styles={style({ color: "gray-500" })}>
          Press Run to execute...
        </Text>
      ) : (
        <Text>{output.join("")}</Text>
      )}
    </div>
  );
}
