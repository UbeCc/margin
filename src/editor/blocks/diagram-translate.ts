/**
 * Translate legacy Typora-style diagram fences into mermaid syntax so everything
 * renders through one engine:
 *   ```sequence  (js-sequence-diagrams syntax)  → mermaid sequenceDiagram
 *   ```flow      (flowchart.js syntax)          → mermaid flowchart TD
 * ```mermaid passes through unchanged.
 */

export const DIAGRAM_LANGS = ['mermaid', 'sequence', 'flow', 'flowchart'] as const;

export function isDiagramLang(lang: string): boolean {
  return (DIAGRAM_LANGS as readonly string[]).includes(lang.toLowerCase());
}

export function toMermaid(lang: string, src: string): string {
  switch (lang.toLowerCase()) {
    case 'sequence':
      return sequenceToMermaid(src);
    case 'flow':
      return flowToMermaid(src);
    case 'flowchart':
      // ```flowchart: mermaid body without the header is common; flowchart.js syntax otherwise
      return /=>/.test(src) ? flowToMermaid(src) : /^\s*(flowchart|graph)\b/.test(src) ? src : `flowchart TD\n${src}`;
    default:
      return src;
  }
}

const ID = (s: string) => s.trim().replace(/[^\p{L}\p{N}_]/gu, '_') || '_';
const quote = (s: string) => '"' + s.trim().replace(/"/g, '#quot;') + '"';

export function sequenceToMermaid(src: string): string {
  const out = ['sequenceDiagram'];
  const declared = new Set<string>();
  const participant = (name: string) => {
    const n = name.trim();
    const id = ID(n);
    if (!declared.has(id)) {
      declared.add(id);
      out.push(`  participant ${id} as ${n.replace(/[;#]/g, ' ')}`);
    }
    return id;
  };
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let m: RegExpExecArray | null;
    if ((m = /^title\s*:?\s*(.*)$/i.exec(line))) {
      out.push(`  %% ${m[1]}`);
      continue;
    }
    if ((m = /^participant\s+(.+)$/i.exec(line))) {
      participant(m[1]);
      continue;
    }
    if ((m = /^note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      const who = m[2].split(',').map(participant).join(',');
      out.push(`  Note ${m[1].toLowerCase()} ${who}: ${m[3]}`);
      continue;
    }
    if ((m = /^(.+?)\s*(-->>|->>|-->|->)\s*(.+?)\s*:\s*(.*)$/.exec(line))) {
      const a = participant(m[1]);
      const b = participant(m[3]);
      const arrow = { '->': '->>', '-->': '-->>', '->>': '-)', '-->>': '--)' }[m[2]]!;
      out.push(`  ${a}${arrow}${b}: ${m[4]}`);
      continue;
    }
    out.push(`  %% ${line}`);
  }
  return out.join('\n');
}

const FLOW_SHAPES: Record<string, (t: string) => string> = {
  start: (t) => `([${quote(t)}])`,
  end: (t) => `([${quote(t)}])`,
  operation: (t) => `[${quote(t)}]`,
  inputoutput: (t) => `[/${quote(t)}/]`,
  subroutine: (t) => `[[${quote(t)}]]`,
  condition: (t) => `{${quote(t)}}`,
  parallel: (t) => `[${quote(t)}]`,
};

export function flowToMermaid(src: string): string {
  const out = ['flowchart TD'];
  const lines = src.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const def = /^([\w-]+)=>(\w+)(?:\s*:\s*>?\s*(.*))?$/.exec(line);
    if (def) {
      const [, id, type, text = id] = def;
      const label = text.replace(/\|[\w]+$/, '').replace(/:>.*$/, '');
      const shape = (FLOW_SHAPES[type] || FLOW_SHAPES.operation)(label);
      out.push(`  ${ID(id)}${shape}`);
      continue;
    }
    if (line.includes('->')) {
      const parts = line.split('->');
      for (let i = 0; i + 1 < parts.length; i++) {
        const from = /^([\w-]+)(?:\(([^)]*)\))?$/.exec(parts[i].trim());
        const to = /^([\w-]+)/.exec(parts[i + 1].trim());
        if (!from || !to) continue;
        const cond = (from[2] || '').split(',')[0].trim();
        const label = cond && cond !== 'left' && cond !== 'right' && cond !== 'top' && cond !== 'bottom' ? `|${cond}|` : '';
        out.push(`  ${ID(from[1])} -->${label} ${ID(to[1])}`);
      }
    }
  }
  return out.join('\n');
}
