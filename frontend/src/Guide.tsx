import { useEffect } from "react";
import { GLOSSARY } from "./plain";

/** First-visit welcome and always-available help: how to use the map, plus the key words. */
export default function Guide({ onClose, onExample, onAddDna }: {
  onClose: () => void;
  onExample: () => void;
  onAddDna: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="guide-backdrop" onClick={onClose}>
      <div className="guide" role="dialog" aria-modal="true" aria-labelledby="guide-title" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn guide-close" onClick={onClose} aria-label="Close">×</button>
        <h1 id="guide-title">Explore the human genome like a map</h1>
        <p className="guide-lead">
          Inside almost every cell in your body is a 3-billion-letter instruction manual: your DNA. This map lets you
          browse it — from whole chromosomes all the way down to individual letters.
        </p>

        <div className="guide-steps">
          <div className="guide-step">
            <div className="guide-icon" aria-hidden>🔍</div>
            <b>Zoom in and out</b>
            <p>Scroll, pinch or use the zoom ladder on the right — like going from a country down to a street.</p>
          </div>
          <div className="guide-step">
            <div className="guide-icon" aria-hidden>🧭</div>
            <b>Search</b>
            <p>Look up a trait like “eye color”, a condition like “cystic fibrosis”, or a gene name.</p>
          </div>
          <div className="guide-step">
            <div className="guide-icon" aria-hidden>🧬</div>
            <b>Add your DNA</b>
            <p>Upload results from 23andMe, AncestryDNA and others to see where your DNA differs.</p>
          </div>
        </div>

        <details className="glossary">
          <summary>Words you'll see</summary>
          <dl>
            {GLOSSARY.map(([term, def]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{def}</dd>
              </div>
            ))}
          </dl>
        </details>

        <div className="guide-actions">
          <button className="primary-btn" onClick={onExample}>Show me the eye-color gene</button>
          <button className="secondary-btn" onClick={onAddDna}>Add my DNA</button>
          <button className="link-btn" onClick={onClose}>Just explore</button>
        </div>
      </div>
    </div>
  );
}
