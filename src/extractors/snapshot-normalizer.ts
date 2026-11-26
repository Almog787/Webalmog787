import { COMPUTED_STYLE_WHITELIST } from '../config.js';
import type {
  Bounds,
  CdpCaptureSnapshotResult,
  NormalizedLayoutNode,
  OverlayNodeEntry,
  ViewportLayoutSnapshot,
} from '../types.js';

const MAX_NODES_PER_VIEWPORT = 2500;
const MAX_TEXT_LENGTH = 160;

const SEMANTIC_TAG_WEIGHTS: Record<string, number> = {
  header: 100,
  nav: 95,
  main: 95,
  footer: 90,
  aside: 80,
  section: 75,
  article: 75,
  dialog: 120,
  form: 75,
  h1: 90,
  h2: 80,
  h3: 70,
  h4: 60,
  button: 85,
  a: 70,
  input: 80,
  select: 80,
  textarea: 80,
  img: 65,
  svg: 55,
  canvas: 85,
  video: 80,
};

export interface DecodedSnapshot {
  viewportSnapshot: ViewportLayoutSnapshot;
  overlays: OverlayNodeEntry[];
  rawOverlaysByKey: Map<string, OverlayNodeEntry>;
}

function getStr(strings: string[], idx: number | undefined): string {
  if (idx === undefined || idx < 0 || idx >= strings.length) {
    return '';
  }
  return strings[idx] ?? '';
}

function parseAttributes(
  attrIndices: number[] | undefined,
  strings: string[],
): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrIndices || attrIndices.length === 0) {
    return attrs;
  }
  for (let i = 0; i + 1 < attrIndices.length; i += 2) {
    const key = getStr(strings, attrIndices[i]).toLowerCase();
    const val = getStr(strings, attrIndices[i + 1]);
    if (key) {
      attrs[key] = val;
    }
  }
  return attrs;
}

function buildSelectorHint(tag: string, id?: string, classes: string[] = []): string {
  let selector = tag || 'div';
  if (id) {
    selector += `#${id}`;
  }
  if (classes.length > 0) {
    selector += `.${classes.slice(0, 3).join('.')}`;
  }
  return selector;
}

function parseNumericZIndex(zIndexRaw: string | undefined): number {
  if (!zIndexRaw || zIndexRaw === 'auto') {
    return 0;
  }
  const parsed = Number.parseInt(zIndexRaw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isOverlayCandidate(
  styles: Record<string, string>,
  role?: string,
  ariaModal?: string,
): { isOverlay: boolean; reason?: string } {
  const reasons: string[] = [];
  const position = styles['position'];
  const zIndexRaw = styles['z-index'];
  const zIndex = parseNumericZIndex(zIndexRaw);

  if (position === 'fixed' || position === 'sticky') {
    reasons.push(`position:${position}`);
  }
  if (role === 'dialog') {
    reasons.push('role:dialog');
  }
  if (ariaModal === 'true') {
    reasons.push('aria-modal:true');
  }
  if (zIndex >= 10) {
    reasons.push(`z-index:${zIndex}`);
  }

  if (reasons.length === 0) {
    return { isOverlay: false };
  }
  return { isOverlay: true, reason: reasons.join('; ') };
}

function scoreNodeSignificance(
  node: NormalizedLayoutNode,
  isOverlay: boolean,
): number {
  let score = SEMANTIC_TAG_WEIGHTS[node.tag] ?? 10;
  if (isOverlay) score += 120;
  if (node.id) score += 35;
  if (node.role) score += 30;
  if (node.ariaLabel) score += 25;
  if (node.href) score += 15;
  if (node.text && node.text.length > 0) score += 20;

  const area = Math.max(0, node.bounds.width * node.bounds.height);
  if (area > 100000) score += 35;
  else if (area > 10000) score += 20;
  else if (area > 1000) score += 10;

  return score;
}

export function overlayKey(entry: OverlayNodeEntry): string {
  return `${entry.selectorHint}|${Math.round(entry.bounds.x)},${Math.round(entry.bounds.y)},${Math.round(entry.bounds.width)},${Math.round(entry.bounds.height)}`;
}

const DEFAULT_STYLE_VALUES: Record<string, Set<string>> = {
  position: new Set(['static']),
  'z-index': new Set(['auto']),
  top: new Set(['auto']),
  left: new Set(['auto']),
  right: new Set(['auto']),
  bottom: new Set(['auto']),
  margin: new Set(['0px']),
  padding: new Set(['0px']),
  'border-radius': new Set(['0px']),
  'border-width': new Set(['0px']),
  'background-color': new Set(['rgba(0, 0, 0, 0)', 'transparent']),
  opacity: new Set(['1']),
  visibility: new Set(['visible']),
  overflow: new Set(['visible']),
  transform: new Set(['none']),
  'box-shadow': new Set(['none']),
  'grid-template-columns': new Set(['none']),
};

function pruneDefaultStyles(styles: Record<string, string>): Record<string, string> {
  const compact: Record<string, string> = {};
  for (const [prop, value] of Object.entries(styles)) {
    const defaults = DEFAULT_STYLE_VALUES[prop];
    if (defaults && defaults.has(value)) {
      continue;
    }
    if (
      prop === 'flex-direction' &&
      value === 'row' &&
      styles['display'] !== 'flex' &&
      styles['display'] !== 'inline-flex'
    ) {
      continue;
    }
    compact[prop] = value;
  }
  return compact;
}

export function normalizeDomSnapshot(
  snapshot: CdpCaptureSnapshotResult,
  viewport: { width: number; height: number },
  styleWhitelist: readonly string[] = COMPUTED_STYLE_WHITELIST,
): DecodedSnapshot {
  const doc = snapshot.documents[0];
  const strings = snapshot.strings ?? [];

  if (!doc || !doc.nodes || !doc.layout) {
    return {
      viewportSnapshot: {
        viewport,
        documentSize: { width: viewport.width, height: viewport.height },
        nodeCount: 0,
        nodes: [],
      },
      overlays: [],
      rawOverlaysByKey: new Map(),
    };
  }

  const parentIndices = doc.nodes.parentIndex ?? [];
  const nodeTypes = doc.nodes.nodeType ?? [];
  const nodeNames = doc.nodes.nodeName ?? [];
  const nodeValues = doc.nodes.nodeValue ?? [];
  const attributesList = doc.nodes.attributes ?? [];

  // Build map from element nodeIdx -> direct child text (collapsed, max 160 chars)
  const directTextByParent = new Map<number, string[]>();
  for (let i = 0; i < nodeTypes.length; i++) {
    if (nodeTypes[i] === 3) {
      const parentIdx = parentIndices[i];
      if (parentIdx !== undefined && parentIdx >= 0) {
        const rawText = getStr(strings, nodeValues[i]).replace(/\s+/g, ' ').trim();
        if (rawText) {
          const existing = directTextByParent.get(parentIdx);
          if (existing) {
            existing.push(rawText);
          } else {
            directTextByParent.set(parentIdx, [rawText]);
          }
        }
      }
    }
  }

  const layoutNodeIndices = doc.layout.nodeIndex ?? [];
  const layoutBounds = doc.layout.bounds ?? [];
  const layoutPaintOrders = doc.layout.paintOrders ?? [];
  const layoutStyles = doc.layout.styles ?? [];

  const visibleCandidates: Array<{
    order: number;
    node: NormalizedLayoutNode;
    overlayEntry?: OverlayNodeEntry;
    significance: number;
  }> = [];

  const overlays: OverlayNodeEntry[] = [];
  const rawOverlaysByKey = new Map<string, OverlayNodeEntry>();

  for (let layoutIdx = 0; layoutIdx < layoutNodeIndices.length; layoutIdx++) {
    const nodeIdx = layoutNodeIndices[layoutIdx];
    if (nodeIdx === undefined || nodeIdx < 0) continue;

    const rawRect = layoutBounds[layoutIdx];
    if (!rawRect || rawRect.length < 4) continue;

    const x = Math.round((rawRect[0] ?? 0) * 100) / 100;
    const y = Math.round((rawRect[1] ?? 0) * 100) / 100;
    const width = Math.round((rawRect[2] ?? 0) * 100) / 100;
    const height = Math.round((rawRect[3] ?? 0) * 100) / 100;

    if (width <= 0 || height <= 0) continue;

    const styleIndices = layoutStyles[layoutIdx] ?? [];
    const styles: Record<string, string> = {};
    for (let sIdx = 0; sIdx < styleWhitelist.length; sIdx++) {
      const propName = styleWhitelist[sIdx];
      const strIdx = styleIndices[sIdx];
      if (propName && strIdx !== undefined && strIdx >= 0) {
        const value = getStr(strings, strIdx);
        if (value) {
          styles[propName] = value;
        }
      }
    }

    if (
      styles['display'] === 'none' ||
      styles['visibility'] === 'hidden' ||
      styles['opacity'] === '0'
    ) {
      continue;
    }

    const rawTag = getStr(strings, nodeNames[nodeIdx]).toLowerCase();
    if (!rawTag || rawTag.startsWith('#')) continue;

    const attrs = parseAttributes(attributesList[nodeIdx], strings);
    const id = attrs['id'] || undefined;
    const classes = attrs['class']
      ? attrs['class'].split(/\s+/).filter(Boolean)
      : [];
    const role = attrs['role'] || undefined;
    const ariaLabel = attrs['aria-label'] || undefined;
    const ariaModal = attrs['aria-modal'] || undefined;
    const href = attrs['href'] || undefined;

    const childTexts = directTextByParent.get(nodeIdx);
    let text: string | undefined;
    if (childTexts && childTexts.length > 0) {
      const joined = childTexts.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) {
        text =
          joined.length > MAX_TEXT_LENGTH
            ? `${joined.slice(0, MAX_TEXT_LENGTH)}...`
            : joined;
      }
    }

    const rawParent = parentIndices[nodeIdx];
    const parentNodeId = rawParent !== undefined && rawParent >= 0 ? rawParent : null;
    const paintOrder = layoutPaintOrders[layoutIdx] ?? 0;
    const bounds: Bounds = { x, y, width, height };
    const compactStyles = pruneDefaultStyles(styles);

    const normalized: NormalizedLayoutNode = {
      nodeId: nodeIdx,
      parentNodeId,
      tag: rawTag,
      ...(id ? { id } : {}),
      classes,
      ...(role ? { role } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(href ? { href } : {}),
      ...(text ? { text } : {}),
      bounds,
      paintOrder,
      styles: compactStyles,
    };

    const overlayCheck = isOverlayCandidate(styles, role, ariaModal);
    let overlayEntry: OverlayNodeEntry | undefined;

    if (overlayCheck.isOverlay) {
      overlayEntry = {
        tag: rawTag,
        selectorHint: buildSelectorHint(rawTag, id, classes),
        ...(role ? { role } : {}),
        ...(ariaModal ? { ariaModal } : {}),
        ...(overlayCheck.reason ? { reason: overlayCheck.reason } : {}),
        bounds,
        paintOrder,
        styles: compactStyles,
      };
      overlays.push(overlayEntry);
      rawOverlaysByKey.set(overlayKey(overlayEntry), overlayEntry);
    }

    visibleCandidates.push({
      order: layoutIdx,
      node: normalized,
      overlayEntry,
      significance: scoreNodeSignificance(normalized, overlayCheck.isOverlay),
    });
  }

  let selectedNodes: NormalizedLayoutNode[];
  if (visibleCandidates.length > MAX_NODES_PER_VIEWPORT) {
    const topBySignificance = [...visibleCandidates]
      .sort((a, b) => b.significance - a.significance || a.order - b.order)
      .slice(0, MAX_NODES_PER_VIEWPORT)
      .sort((a, b) => a.order - b.order);
    selectedNodes = topBySignificance.map((entry) => entry.node);
  } else {
    selectedNodes = visibleCandidates.map((entry) => entry.node);
  }

  const docWidth = Math.max(viewport.width, Math.round(doc.contentWidth ?? viewport.width));
  const docHeight = Math.max(viewport.height, Math.round(doc.contentHeight ?? viewport.height));

  return {
    viewportSnapshot: {
      viewport,
      documentSize: { width: docWidth, height: docHeight },
      nodeCount: selectedNodes.length,
      nodes: selectedNodes,
    },
    overlays,
    rawOverlaysByKey,
  };
}
