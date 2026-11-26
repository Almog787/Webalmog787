import type { CDPSession, Page } from 'patchright';
import { COMPUTED_STYLE_WHITELIST } from '../config.js';
import type {
  CdpCaptureSnapshotResult,
  HoverFocusDelta,
  OverlayNodeEntry,
  ProbedStateEntry,
} from '../types.js';
import { normalizeDomSnapshot, overlayKey } from './snapshot-normalizer.js';

const MAX_PSEUDO_STATE_ELEMENTS = 15;
const MAX_DISCLOSURE_TRIGGERS = 5;
const SCROLL_WAIT_MS = 350;

const HOVER_FOCUS_DIFF_PROPS = new Set<string>([
  'background-color',
  'color',
  'border-color',
  'border-width',
  'border-radius',
  'opacity',
  'visibility',
  'transform',
  'box-shadow',
  'display',
]);

interface CdpComputedStyleProperty {
  name: string;
  value: string;
}

interface CdpDescribeNodeResult {
  node?: {
    localName?: string;
    attributes?: string[];
  };
}

function formatCdpNodeSelector(desc: CdpDescribeNodeResult): string {
  const localName = desc.node?.localName || 'element';
  const attrs = desc.node?.attributes ?? [];
  let id = '';
  let classes = '';
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const key = attrs[i]?.toLowerCase();
    const val = attrs[i + 1] ?? '';
    if (key === 'id' && val) id = `#${val}`;
    if (key === 'class' && val) {
      classes = `.${val.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`;
    }
  }
  return `${localName}${id}${classes}`;
}

function toStyleMap(list: CdpComputedStyleProperty[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of list) {
    if (HOVER_FOCUS_DIFF_PROPS.has(item.name)) {
      map[item.name] = item.value;
    }
  }
  return map;
}

function computeStyleDelta(
  before: Record<string, string>,
  after: Record<string, string>,
): Record<string, string> {
  const delta: Record<string, string> = {};
  for (const [prop, afterVal] of Object.entries(after)) {
    if (before[prop] !== afterVal) {
      delta[prop] = afterVal;
    }
  }
  return delta;
}

export async function performScrollSweep(page: Page): Promise<void> {
  const scrollHeight = await page
    .evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0))
    .catch(() => 0);

  if (scrollHeight <= 0) return;

  const stops = [
    0,
    Math.round(scrollHeight * 0.5),
    scrollHeight,
    0,
  ];

  for (const y of stops) {
    await page
      .evaluate((targetY) => {
        window.scrollTo({ top: targetY, behavior: 'instant' as ScrollBehavior });
      }, y)
      .catch(() => undefined);
    await page.waitForTimeout(SCROLL_WAIT_MS);
  }
}

async function probeHoverFocusStates(
  cdpClient: CDPSession,
): Promise<HoverFocusDelta[]> {
  const deltas: HoverFocusDelta[] = [];
  try {
    await cdpClient.send('DOM.enable');
    await cdpClient.send('CSS.enable');

    const docRes = (await cdpClient.send('DOM.getDocument', { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootNodeId = docRes.root?.nodeId;
    if (!rootNodeId) return deltas;

    const queryRes = (await cdpClient.send('DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector: 'button, a, [role="button"], input',
    })) as { nodeIds?: number[] };

    const targetNodeIds = (queryRes.nodeIds ?? []).slice(0, MAX_PSEUDO_STATE_ELEMENTS);

    for (const nodeId of targetNodeIds) {
      try {
        const desc = (await cdpClient.send('DOM.describeNode', {
          nodeId,
        })) as CdpDescribeNodeResult;
        const selector = formatCdpNodeSelector(desc);

        const baseRes = (await cdpClient.send('CSS.getComputedStyleForNode', {
          nodeId,
        })) as { computedStyle?: CdpComputedStyleProperty[] };
        const baseMap = toStyleMap(baseRes.computedStyle ?? []);

        for (const pseudo of ['hover', 'focus'] as const) {
          await cdpClient.send('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: [pseudo],
          });
          const afterRes = (await cdpClient.send('CSS.getComputedStyleForNode', {
            nodeId,
          })) as { computedStyle?: CdpComputedStyleProperty[] };
          const afterMap = toStyleMap(afterRes.computedStyle ?? []);
          const changedStyles = computeStyleDelta(baseMap, afterMap);
          if (Object.keys(changedStyles).length > 0) {
            deltas.push({
              selector,
              pseudoState: pseudo,
              changedStyles,
            });
          }
        }

        await cdpClient.send('CSS.forcePseudoState', {
          nodeId,
          forcedPseudoClasses: [],
        });
      } catch {
        // Ignore detached or unstylable nodes
      }
    }
  } catch {
    // Non-fatal if DOM/CSS domains reject on special pages
  }

  return deltas;
}

export async function probePageStates(
  page: Page,
  cdpClient: CDPSession,
  viewport: { width: number; height: number },
): Promise<ProbedStateEntry[]> {
  await performScrollSweep(page);

  const hoverFocusDeltas = await probeHoverFocusStates(cdpClient);
  const probedStates: ProbedStateEntry[] = [];

  if (hoverFocusDeltas.length > 0) {
    probedStates.push({
      triggerSelector: 'CSS.forcePseudoState(:hover,:focus)',
      revealedOverlays: [],
      hoverFocusDeltas,
    });
  }

  const triggerDescriptors = await page
    .evaluate((limit) => {
      const candidates = Array.from(
        document.querySelectorAll(
          'button[aria-expanded="false"], [aria-haspopup="menu"], [aria-haspopup="dialog"]',
        ),
      );
      const selected: Array<{ index: number; selectorHint: string }> = [];
      for (let i = 0; i < candidates.length && selected.length < limit; i++) {
        const el = candidates[i];
        if (!el) continue;
        const tag = el.tagName.toLowerCase();
        // Exclude navigation anchors
        if (tag === 'a' && el.hasAttribute('href')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const id = el.id ? `#${el.id}` : '';
        const ariaExpanded = el.getAttribute('aria-expanded');
        const ariaHaspopup = el.getAttribute('aria-haspopup');
        const attrHint =
          ariaExpanded !== null
            ? `[aria-expanded="${ariaExpanded}"]`
            : ariaHaspopup
              ? `[aria-haspopup="${ariaHaspopup}"]`
              : '';
        selected.push({
          index: i,
          selectorHint: `${tag}${attrHint}${id}`,
        });
      }
      return selected;
    }, MAX_DISCLOSURE_TRIGGERS)
    .catch(() => []);

  if (triggerDescriptors.length === 0) {
    return probedStates;
  }

  const baselineRaw = (await cdpClient
    .send('DOMSnapshot.captureSnapshot', {
      computedStyles: [...COMPUTED_STYLE_WHITELIST],
      includeDOMRects: true,
      includePaintOrder: true,
    })
    .catch(() => null)) as CdpCaptureSnapshotResult | null;

  const baselineKeys = new Set<string>();
  if (baselineRaw) {
    const decoded = normalizeDomSnapshot(baselineRaw, viewport);
    for (const key of decoded.rawOverlaysByKey.keys()) {
      baselineKeys.add(key);
    }
  }

  const triggerLocator = page.locator(
    'button[aria-expanded="false"], [aria-haspopup="menu"], [aria-haspopup="dialog"]',
  );

  for (const descriptor of triggerDescriptors) {
    const initialUrl = page.url();
    try {
      const target = triggerLocator.nth(descriptor.index);
      await target.click({ timeout: 2000 });
      await page.waitForTimeout(250);

      if (page.url() !== initialUrl) {
        await page
          .goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => undefined);
        break;
      }

      const deltaRaw = (await cdpClient
        .send('DOMSnapshot.captureSnapshot', {
          computedStyles: [...COMPUTED_STYLE_WHITELIST],
          includeDOMRects: true,
          includePaintOrder: true,
        })
        .catch(() => null)) as CdpCaptureSnapshotResult | null;

      if (deltaRaw) {
        const deltaDecoded = normalizeDomSnapshot(deltaRaw, viewport);
        const revealedOverlays: OverlayNodeEntry[] = [];
        for (const [key, entry] of deltaDecoded.rawOverlaysByKey.entries()) {
          if (!baselineKeys.has(key)) {
            revealedOverlays.push(entry);
          }
        }
        if (revealedOverlays.length > 0) {
          probedStates.push({
            triggerSelector: descriptor.selectorHint,
            revealedOverlays,
            hoverFocusDeltas: [],
          });
        }
      }

      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(150);
    } catch {
      if (page.url() !== initialUrl) {
        await page
          .goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => undefined);
        break;
      }
    }
  }

  return probedStates;
}
