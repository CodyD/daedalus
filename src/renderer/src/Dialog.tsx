import { CSSProperties, ReactNode, useId, useRef } from "react";
import { useModal } from "./a11y";

interface Props {
  title: string;
  onClose: () => void;
  /** False while the dialog must stay open (e.g. an import is running). */
  closable?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Modal dialog: labelled by its heading, focus kept inside, Escape and backdrop click close it. */
export function Dialog({ title, onClose, closable = true, className, style, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => closable && onClose();
  useModal(ref, close);
  return (
    <div className="backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className={`dialog${className ? ` ${className}` : ""}`} style={style}
        role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
