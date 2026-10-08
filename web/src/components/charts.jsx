import { useState, useRef, useEffect } from 'preact/hooks';
import { money, shortDay } from '../api.js';

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Daily revenue columns with a hover tooltip. `days` = [{ day: 'YYYY-MM-DD', revenue }] (cents). */
export function DailyBars({ days }) {
  const [hot, setHot] = useState(null);
  const box = useRef();
  const [W, setW] = useState(720);
  // Draw at the real pixel width so axis text stays 11px on phones and wide screens alike.
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = W < 500 ? 180 : 240, L = 40, B = 22, T = 8;
  const max = niceMax(Math.max(...days.map((d) => d.revenue), 0) / 100);
  const step = (W - L) / Math.max(days.length, 1);
  const bw = Math.max(2, Math.min(28, step - 2));
  const y = (v) => T + (H - T - B) * (1 - v / 100 / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(days.length / Math.max(3, Math.floor(W / 70)));
  return (
    <div class="chart" ref={box} onMouseLeave={() => setHot(null)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Revenue by day">
        <g class="grid">
          {ticks.map((t) => <line key={t} x1={L} x2={W} y1={y(t * 100)} y2={y(t * 100)} />)}
        </g>
        <g class="axis">
          {ticks.map((t) => <text key={t} x={L - 6} y={y(t * 100) + 4} text-anchor="end">{compact.format(t)}</text>)}
          {days.map((d, i) => i % labelEvery === 0 && (
            <text key={d.day} x={L + i * step + step / 2} y={H - 6} text-anchor="middle">{shortDay(d.day)}</text>
          ))}
        </g>
        {days.map((d, i) => {
          const x = L + i * step + (step - bw) / 2;
          const top = y(d.revenue);
          const h = Math.max(0, H - B - top);
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={d.day} onMouseEnter={() => setHot(i)}>
              <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" />
              {h > 0 && (
                <path class={'bar' + (hot === i ? ' hot' : '')}
                  d={`M${x},${H - B} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - B} Z`} />
              )}
            </g>
          );
        })}
      </svg>
      {hot !== null && (
        <div class="tip" style={{ left: `${((L + hot * step + step / 2) / W) * 100}%`, top: `${(y(days[hot].revenue) / H) * 100}%` }}>
          {days[hot].day}: <b>{money(days[hot].revenue)}</b>{days[hot].invoices != null && ` · ${days[hot].invoices} invoices`}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars: [{ label, value, href, sub }] */
export function RankBars({ rows, format = money }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <div class="empty">No sales in this period</div>;
  return (
    <div class="hbars">
      {rows.map((r) => (
        <div class="hbar" key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <div class="top">
            <a class="grow" href={r.href}>{r.label}</a>
            <span class="num">{format(r.value)}</span>
          </div>
          <div class="track"><div class="fill" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
