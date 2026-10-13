// 固定 DOM 顺序；滚动只影响视觉，选择由调用方明确更新。
const controllers = new WeakMap();
const cardSelector = '.scene-card[data-scene]';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function initialSelection(strip) {
  return [...strip.children].find(card => card.matches(cardSelector) &&
    (card.classList.contains('selected') || card.getAttribute('aria-checked') === 'true' ||
      card.getAttribute('aria-pressed') === 'true'))?.dataset.scene ?? null;
}

/**
 * 同一个 strip 重复接入会复用控制器，不会重复添加监听。
 * update({ selectedId, reducedMotion }) 立即更新选择，不主动改变滚动位置。
 * sync() 在增删卡片后刷新尺寸；center() 显式居中；destroy() 释放资源。
 */
export function attachCarousel(strip, options = {}) {
  if (!strip?.ownerDocument || typeof strip.querySelectorAll !== 'function') {
    throw new TypeError('attachCarousel 需要一个场景卡片容器元素。');
  }
  const existing = controllers.get(strip);
  if (existing) return existing.update(options);

  const doc = strip.ownerDocument;
  const view = doc.defaultView;
  const motion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  let selectedId = initialSelection(strip);
  let motionOverride = false;
  let reducedMotion = !!motion?.matches;
  let cards = [];
  let entries = [];
  let viewport = 0;
  let maxScroll = 0;
  let dirty = true;
  let frame = 0;
  let destroyed = false;
  let pendingCenter = null;
  let drag = null;
  let suppressedClick = null;
  const observedCards = new Set();
  const originalStyles = new Map();
  const originalReady = strip.classList.contains('carousel-ready');
  const originalReduced = strip.classList.contains('carousel-reduced');
  const now = () => view.performance.now();

  function setVariable(element, name, value) {
    let originals = originalStyles.get(element);
    if (!originals) originalStyles.set(element, originals = new Map());
    if (!originals.has(name)) originals.set(name, [element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  }

  function restoreVariables(element) {
    for (const [name, [value, priority]] of originalStyles.get(element) || []) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
    originalStyles.delete(element);
  }

  function focusableCards() {
    return cards.filter(card => !card.disabled && card.getAttribute('aria-disabled') !== 'true');
  }

  function detectStructureChange() {
    // DOM 刚更新时 MutationObserver 尚未回调；显式 API 仍需立即看到新卡片。
    if (dirty) return;
    const current = [...strip.children].filter(card => card.matches(cardSelector));
    dirty = current.length !== cards.length || current.some((card, index) => card !== cards[index]);
  }

  function updateTabStops(preferred) {
    const enabled = focusableCards();
    const target = (enabled.includes(preferred) && preferred) ||
      enabled.find(card => card.dataset.scene === selectedId) || enabled[0];
    for (const card of cards) card.tabIndex = card === target ? 0 : -1;
  }

  function applySelection() {
    for (const card of cards) {
      const selected = card.dataset.scene === selectedId;
      card.classList.toggle('selected', selected);
      if (card.getAttribute('role') === 'radio') card.setAttribute('aria-checked', String(selected));
      else if (card.tagName === 'BUTTON' || card.getAttribute('role') === 'button') card.setAttribute('aria-pressed', String(selected));
    }
    // 保留正在用方向键浏览的焦点，不在异步结果回来时抢走焦点。
    updateTabStops(cards.includes(doc.activeElement) ? doc.activeElement : null);
  }

  function applyProximity() {
    if (!viewport) return;
    const center = strip.scrollLeft + viewport / 2;
    const falloff = Math.max(viewport * .7, 1);
    for (const entry of entries) {
      const distance = reducedMotion ? 0 : clamp(Math.abs(entry.center - center) / falloff, 0, 1);
      const scale = (1 - .1 * distance).toFixed(3);
      const opacity = (1 - .14 * distance).toFixed(3);
      if (entry.scale !== scale) {
        setVariable(entry.card, '--carousel-scale', scale);
        entry.scale = scale;
      }
      if (entry.opacity !== opacity) {
        setVariable(entry.card, '--carousel-opacity', opacity);
        entry.opacity = opacity;
      }
    }
  }

  function scrollToCard(sceneId, smooth) {
    const entry = entries.find(item => item.card.dataset.scene === sceneId);
    if (!entry) return false;
    if (!viewport) {
      // 隐藏的视图在重新显示并测得宽度后再完成居中。
      pendingCenter = { sceneId, smooth };
      return true;
    }
    pendingCenter = null;
    const left = clamp(entry.center - viewport / 2, 0, maxScroll);
    strip.scrollTo({ left, behavior: smooth && !reducedMotion ? 'smooth' : 'instant' });
    applyProximity();
    return true;
  }

  function measure() {
    dirty = false;
    cards = [...strip.children].filter(card => card.matches(cardSelector));
    for (const card of observedCards) {
      if (!cards.includes(card)) {
        resizeObserver?.unobserve(card);
        observedCards.delete(card);
        restoreVariables(card);
      }
    }
    for (const card of cards) {
      if (!observedCards.has(card)) {
        observedCards.add(card);
        resizeObserver?.observe(card, { box: 'border-box' });
      }
    }
    viewport = strip.clientWidth;
    if (viewport) {
      // 移动端百分比宽度基于整个视口，避免 edge padding 与 flex 百分比相互反馈。
      setVariable(strip, '--carousel-viewport', `${viewport}px`);
      const firstWidth = cards[0]?.offsetWidth ?? viewport;
      const lastWidth = cards.at(-1)?.offsetWidth ?? viewport;
      setVariable(strip, '--carousel-edge-start', `${Math.max(8, (viewport - firstWidth) / 2)}px`);
      setVariable(strip, '--carousel-edge-end', `${Math.max(8, (viewport - lastWidth) / 2)}px`);
    }
    // CSS 决定卡片实际占位（含移动端）；缩放只负责选中与边缘效果。
    // offsetWidth / offsetLeft 不含 transform；滚动帧复用这些坐标，不重复测量布局。
    entries = cards.map(card => ({ card, center: card.offsetLeft + card.offsetWidth / 2 }));
    maxScroll = Math.max(0, strip.scrollWidth - viewport);
    applySelection();
    if (pendingCenter && viewport) scrollToCard(pendingCenter.sceneId, pendingCenter.smooth);
  }

  function queueFrame(layout = false) {
    if (destroyed) return;
    dirty ||= layout;
    if (!frame) frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (dirty) measure();
      applyProximity();
    });
  }

  function updateMotion() {
    const wasReduced = reducedMotion;
    reducedMotion = motionOverride || !!motion?.matches;
    strip.classList.toggle('carousel-reduced', reducedMotion);
    if (!wasReduced && reducedMotion) {
      // 动画中途打开减少动态效果，也立即停止原生平滑滚动。
      strip.scrollTo({ left: strip.scrollLeft, behavior: 'instant' });
    }
    applyProximity();
  }

  function onPointerDown(event) {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.isPrimary === false) return;
    const nestedControl = event.target.closest('a,input,select,textarea,[contenteditable="true"],button');
    if (nestedControl && !nestedControl.matches(cardSelector)) return;
    const bounds = strip.getBoundingClientRect();
    if (event.clientY >= bounds.top + strip.clientTop + strip.clientHeight) return;
    suppressedClick = null;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: strip.scrollLeft, active: false };
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (!(event.buttons & 1)) return finishDrag(true);
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) <= 7 || Math.abs(dx) < Math.abs(dy)) return;
      drag.active = true;
      pendingCenter = null;
      strip.classList.add('is-dragging');
      strip.scrollTo({ left: strip.scrollLeft, behavior: 'instant' });
    }
    event.preventDefault();
    strip.scrollLeft = drag.left - dx;
    queueFrame();
  }

  function finishDrag(cancelled = false) {
    if (!drag) return;
    if (drag.active && !cancelled) suppressedClick = { id: drag.id, until: now() + 400 };
    drag = null;
    strip.classList.remove('is-dragging');
    queueFrame();
  }

  function onPointerUp(event) {
    if (drag?.id === event.pointerId) finishDrag(event.type === 'pointercancel');
  }

  function onBlur() { finishDrag(true); }

  function onClick(event) {
    // 不在 pointerdown 捕获指针：普通 click 保持原生目标，只拦截拖动释放生成的 click。
    if (!suppressedClick || event.detail === 0) return;
    const suppression = suppressedClick;
    suppressedClick = null;
    if (now() > suppression.until || (event.pointerId != null && event.pointerId !== suppression.id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onFocus(event) {
    const card = event.target.closest(cardSelector);
    if (cards.includes(card)) updateTabStops(card);
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const card = event.target.closest(cardSelector);
    if (!card || card !== event.target || !strip.contains(card)) return;
    detectStructureChange();
    if (dirty) measure();
    const enabled = focusableCards();
    const index = enabled.indexOf(card);
    if (index < 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) card.click();
      return;
    }
    let target;
    if (event.key === 'ArrowRight') target = enabled[Math.min(index + 1, enabled.length - 1)];
    else if (event.key === 'ArrowLeft') target = enabled[Math.max(index - 1, 0)];
    else if (event.key === 'Home') target = enabled[0];
    else if (event.key === 'End') target = enabled.at(-1);
    else return;
    event.preventDefault();
    event.stopPropagation();
    updateTabStops(target);
    target.focus({ preventScroll: true });
    scrollToCard(target.dataset.scene, true);
  }

  const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(() => queueFrame(true)) : null;
  const mutationObserver = view.MutationObserver ? new view.MutationObserver(() => queueFrame(true)) : null;
  const onScroll = () => queueFrame();
  const onResize = () => queueFrame(true);
  const api = {
    update(next = {}) {
      if (destroyed) return api;
      if (Object.hasOwn(next, 'selectedId')) {
        selectedId = next.selectedId == null ? null : String(next.selectedId);
        if (pendingCenter && pendingCenter.sceneId !== selectedId) pendingCenter = null;
      }
      if (Object.hasOwn(next, 'reducedMotion')) motionOverride = next.reducedMotion === true;
      detectStructureChange();
      if (dirty) measure();
      else applySelection();
      updateMotion();
      return api;
    },
    sync() { queueFrame(true); return api; },
    center(sceneId, { smooth = true } = {}) {
      if (destroyed) return false;
      detectStructureChange();
      if (dirty) measure();
      return scrollToCard(String(sceneId), smooth);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) view.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      strip.removeEventListener('scroll', onScroll);
      strip.removeEventListener('pointerdown', onPointerDown);
      strip.removeEventListener('click', onClick, true);
      strip.removeEventListener('focusin', onFocus);
      strip.removeEventListener('keydown', onKeyDown, true);
      view.removeEventListener('pointermove', onPointerMove);
      view.removeEventListener('pointerup', onPointerUp, true);
      view.removeEventListener('pointercancel', onPointerUp, true);
      view.removeEventListener('blur', onBlur);
      view.removeEventListener('resize', onResize);
      motion?.removeEventListener?.('change', updateMotion);
      strip.classList.remove('is-dragging');
      strip.classList.toggle('carousel-ready', originalReady);
      strip.classList.toggle('carousel-reduced', originalReduced);
      for (const element of [...originalStyles.keys()]) restoreVariables(element);
      pendingCenter = drag = suppressedClick = null;
      cards = entries = [];
      observedCards.clear();
      controllers.delete(strip);
    }
  };

  controllers.set(strip, api);
  strip.classList.add('carousel-ready');
  strip.addEventListener('scroll', onScroll, { passive: true });
  strip.addEventListener('pointerdown', onPointerDown);
  strip.addEventListener('click', onClick, true);
  strip.addEventListener('focusin', onFocus);
  strip.addEventListener('keydown', onKeyDown, true);
  view.addEventListener('pointermove', onPointerMove, { passive: false });
  view.addEventListener('pointerup', onPointerUp, true);
  view.addEventListener('pointercancel', onPointerUp, true);
  view.addEventListener('blur', onBlur);
  view.addEventListener('resize', onResize, { passive: true });
  motion?.addEventListener?.('change', updateMotion);
  resizeObserver?.observe(strip, { box: 'border-box' });
  mutationObserver?.observe(strip, { childList: true, subtree: true });
  api.update(options);
  if (selectedId !== null) api.center(selectedId, { smooth: false });
  return api;
}

/** 显式居中不改变选择，返回目标卡片是否存在。 */
export function centerCard(strip, sceneId, options = {}) {
  return (controllers.get(strip) || attachCarousel(strip)).center(sceneId, options);
}

/** keyed DOM 增删节点后调用；下一帧统一刷新布局与视觉。 */
export function syncCarousel(strip) {
  return (controllers.get(strip) || attachCarousel(strip)).sync();
}
