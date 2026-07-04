import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import styles from './TerminalChart.module.css';

/**
 * lightweight-charts wrapper in terminal trim: true-black canvas, hairline
 * grid, amber/blue line series, crosshair readout in a legend strip. Colors
 * are read from the token CSS variables — no hex here.
 *
 * The chart instance is created ONCE per mount; data refreshes call
 * setData() in place, so SSE refetches never flicker the canvas or reset the
 * user's zoom. The view refits only when `fitKey` changes (new entity/range).
 * The series COUNT and per-series config must be stable across renders.
 */

export interface ChartSeries {
  label: string;
  /** Token variable name, e.g. "--amber". */
  colorVar: string;
  points: { time: Time; value: number }[];
  /** Separate price scale id (e.g. rank vs elo). Default: right scale. */
  scaleId?: string;
  /** Rank-style scales read better inverted (1 on top). */
  invert?: boolean;
  decimals?: number;
}

function tokenColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TerminalChart({ series, fitKey }: { series: ChartSeries[]; fitKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const linesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const lastFitKey = useRef<string | null>(null);
  const [readout, setReadout] = useState<{ ts: string; values: (number | null)[] } | null>(null);

  /* Create once per mount. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const border = tokenColor('--panel-border');
    const label = tokenColor('--label');
    const chart: IChartApi = createChart(el, {
      layout: {
        background: { color: tokenColor('--bg') },
        textColor: label,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        // On-screen logo off (breaks the terminal frame); TradingView's
        // lightweight-charts attribution lives in the README instead.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: border },
        horzLines: { color: border },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: label, width: 1, labelBackgroundColor: border },
        horzLine: { color: label, width: 1, labelBackgroundColor: border },
      },
      rightPriceScale: { borderColor: border },
      leftPriceScale: { borderColor: border, visible: series.some((s) => s.scaleId === 'left') },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;

    linesRef.current = series.map((s) => {
      const line = chart.addLineSeries({
        color: tokenColor(s.colorVar),
        lineWidth: 1,
        priceScaleId: s.scaleId ?? 'right',
        priceLineVisible: false,
        lastValueVisible: true,
      });
      if (s.invert) line.priceScale().applyOptions({ invertScale: true });
      return line;
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || param.point === undefined) {
        setReadout(null);
        return;
      }
      const values = linesRef.current.map((line) => {
        const datum = param.seriesData.get(line) as { value?: number } | undefined;
        return datum?.value ?? null;
      });
      const ts =
        typeof param.time === 'string'
          ? param.time
          : new Date((param.time as number) * 1000).toISOString().slice(0, 10);
      setReadout({ ts, values });
    });

    const resize = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    resize.observe(el);
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      linesRef.current = [];
      lastFitKey.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Data refresh: update in place; refit only for a new entity/range. */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    series.forEach((s, i) => linesRef.current[i]?.setData(s.points));
    if (lastFitKey.current !== fitKey) {
      lastFitKey.current = fitKey;
      chart.timeScale().fitContent();
    }
  }, [series, fitKey]);

  return (
    <div className={styles.root}>
      <div className={styles.legend}>
        {series.map((s, i) => {
          const live = s.points[s.points.length - 1]?.value ?? null;
          const shown = readout?.values[i] ?? live;
          return (
            <span key={s.label} className={styles.series}>
              <span className={styles.serieslabel}>{s.label}</span>
              <span className={styles.seriesvalue} style={{ color: `var(${s.colorVar})` }}>
                {shown === null ? '—' : shown.toFixed(s.decimals ?? 2)}
              </span>
            </span>
          );
        })}
        <span className={styles.crosshairts}>{readout ? readout.ts : ''}</span>
      </div>
      <div ref={containerRef} className={styles.chart} />
    </div>
  );
}