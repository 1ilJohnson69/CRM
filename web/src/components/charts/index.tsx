import { useMemo, useRef, useState, type ReactNode } from 'react';

/** Hook: measures container width so SVG charts render at true pixel size. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  const observer = useMemo(
    () => (typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(([e]) => setWidth(Math.max(120, Math.floor(e.contentRect.width))))),
    [],
  );
  const setRef = (el: T | null) => {
    if (ref.current && observer) observer.unobserve(ref.current);
    (ref as { current: T | null }).current = el;
    if (el && observer) {
      observer.observe(el);
      setWidth(Math.max(120, Math.floor(el.getBoundingClientRect().width)));
    }
  };
  return [setRef, width] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function smoothPath(pts: [number, number][]) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

// ------------------------------------------------------------- sparkline --

export function Sparkline({ values, width = 96, height = 30, color = 'var(--accent)', variant = 'line' }: {
  values: number[]; width?: number; height?: number; color?: string; variant?: 'line' | 'bars';
}) {
  const max = Math.max(...values, 1);
  const min = variant === 'bars' ? 0 : Math.min(...values);
  const span = max - min || 1;
  if (variant === 'bars') {
    const gap = 2;
    const bw = (width - gap * (values.length - 1)) / values.length;
    return (
      <svg className="sparkline" width={width} height={height} aria-hidden>
        {values.map((v, i) => {
          const h = Math.max(2, ((v - min) / span) * height);
          return <rect key={i} x={i * (bw + gap)} y={height - h} width={bw} height={h} rx={Math.min(2, bw / 2)} fill={color} opacity={i === values.length - 1 ? 1 : 0.38} />;
        })}
      </svg>
    );
  }
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as [number, number]);
  const id = `sg${Math.round(values.reduce((a, b) => a + b, 0)) % 100000}${values.length}`;
  return (
    <svg className="sparkline" width={width} height={height} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${smoothPath(pts)} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <circle cx={pts.at(-1)![0]} cy={pts.at(-1)![1]} r={3} fill={color} stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

// --------------------------------------------------------- stacked area --

export interface Series { key: string; label: string; color: string }

export function StackedArea({ data, series, height = 260, xLabel, yFormat, tooltipTitle, valueFormat }: {
  data: Record<string, number | string>[]; series: Series[]; height?: number;
  xLabel: (row: Record<string, number | string>, i: number) => string;
  yFormat: (n: number) => string; valueFormat: (n: number) => string;
  tooltipTitle: (row: Record<string, number | string>) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { t: 12, r: 8, b: 26, l: 52 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;

  const totals = data.map((r) => series.reduce((s, se) => s + Number(r[se.key] ?? 0), 0));
  const yMax = niceMax(Math.max(...totals, 1) * 1.08);
  const x = (i: number) => pad.l + (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v: number) => pad.t + h - (v / yMax) * h;

  const layers = useMemo(() => {
    const base = data.map(() => 0);
    return series.map((s) => {
      const lower = [...base];
      data.forEach((r, i) => (base[i] += Number(r[s.key] ?? 0)));
      const upper = [...base];
      return { s, lower, upper };
    });
  }, [data, series]);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(w / 70))));

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
  };

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Revenue by service over time">
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 10} y={y(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {data.map((r, i) => (i % labelEvery === 0 || i === data.length - 1) && (i === data.length - 1 || data.length - 1 - i >= labelEvery) ? (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>{xLabel(r, i)}</text>
          ) : null)}
        </g>
        {layers.map(({ s, lower, upper }) => {
          const top = upper.map((v, i) => [x(i), y(v)] as [number, number]);
          const bottom = lower.map((v, i) => [x(i), y(v)] as [number, number]).reverse();
          const d = `${smoothPath(top)} L${bottom[0][0]},${bottom[0][1]} ${smoothPath(bottom).slice(1)} Z`;
          return (
            <g key={s.key}>
              <path d={d} fill={s.color} fillOpacity={0.2} />
              <path d={smoothPath(top)} fill="none" stroke={s.color} strokeWidth={2} />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} />
            {layers.map(({ s, upper }) => Number(data[hover][s.key]) > 0 && (
              <circle key={s.key} cx={x(hover)} cy={y(upper[hover])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={w} height={h} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(hover), 100), width - 100), top: y(totals[hover]) }}>
          <div className="tt-title">{tooltipTitle(data[hover])}</div>
          {[...series].reverse().map((s) => (
            <div key={s.key} className="tt-row"><span><i style={{ background: s.color }} />{s.label}</span><b>{valueFormat(Number(data[hover][s.key] ?? 0))}</b></div>
          ))}
          <div className="tt-row tt-total"><span>Total</span><b>{valueFormat(totals[hover])}</b></div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ donut --

export function Donut({ segments, size = 168, thickness = 16, center }: {
  segments: { key: string; value: number; color: string; label: string }[]; size?: number; thickness?: number; center?: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = segments.filter((s) => s.value > 0).length > 1 ? 3 : 0; // surface gap between fills
  let offset = 0;
  const hovered = segments.find((s) => s.key === hover);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }} role="img" aria-label="Membership status distribution">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
        {segments.map((s) => {
          const len = (s.value / total) * c;
          const dash = Math.max(0, len - gap);
          const el = s.value > 0 && (
            <circle
              key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color}
              strokeWidth={hover === s.key ? thickness + 4 : thickness} strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
              style={{ transition: 'stroke-width 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none' }}>
        {hovered ? (
          <div>
            <div style={{ fontSize: 24, fontWeight: 800 }} className="num">{hovered.value.toLocaleString('en-IN')}</div>
            <div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{hovered.label} · {Math.round((hovered.value / total) * 100)}%</div>
          </div>
        ) : center}
      </div>
    </div>
  );
}
