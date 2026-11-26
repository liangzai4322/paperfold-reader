function clip(points, distance) {
  const result = [];
  let previous = points.at(-1);
  let previousDistance = distance(previous);
  for (const point of points) {
    const currentDistance = distance(point);
    if ((currentDistance < 0) !== (previousDistance < 0)) {
      const fraction = previousDistance / (previousDistance - currentDistance);
      result.push({
        x: previous.x + (point.x - previous.x) * fraction,
        y: previous.y + (point.y - previous.y) * fraction,
      });
    }
    if (currentDistance >= 0) result.push(point);
    previous = point;
    previousDistance = currentDistance;
  }
  return result;
}

export function foldGeometry(width, height, anchor, drag) {
  const dx = anchor.x - drag.x;
  const dy = anchor.y - drag.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;

  const normal = { x: dx / length, y: dy / length };
  const middle = { x: (anchor.x + drag.x) / 2, y: (anchor.y + drag.y) / 2 };
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const distance = (point) => (point.x - middle.x) * normal.x + (point.y - middle.y) * normal.y;
  const front = clip(corners, (point) => -distance(point));
  const revealed = clip(corners, distance);
  const reverse = revealed.map((point) => {
    const reflection = 2 * distance(point);
    return { x: point.x - reflection * normal.x, y: point.y - reflection * normal.y };
  });
  return {
    front,
    revealed,
    reverse,
    gradientAngle: Math.atan2(normal.x, -normal.y) * 180 / Math.PI,
    gradientOffset: -distance({ x: width / 2, y: height / 2 }),
  };
}

function polygon(points) {
  if (points.length < 3) return "polygon(0 0, 0 0, 0 0)";
  return "polygon(" + points.map(({ x, y }) => x.toFixed(1) + "px " + y.toFixed(1) + "px").join(",") + ")";
}

export function bindPageTurn(stage, { front, reverse, shadow, preview, commit }) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let pointer = null;
  let turn = null;
  let frame = 0;
  let pendingMotion = null;

  function clear() {
    cancelAnimationFrame(frame);
    pendingMotion = null;
    frame = 0;
    if (pointer && stage.hasPointerCapture(pointer.id)) stage.releasePointerCapture(pointer.id);
    pointer = null;
    turn = null;
    stage.classList.remove("is-turning");
    front.style.removeProperty("clip-path");
  }

  function begin(direction, box, y) {
    const page = preview(direction);
    if (!page) return false;
    turn = {
      page, direction, box,
      anchor: { x: direction === 1 ? box.width : 0, y },
      travel: 0,
      lift: 0,
    };
    if (!reducedMotion.matches) stage.classList.add("is-turning");
    return true;
  }

  function paint(travel, lift) {
    const { anchor, box, direction } = turn;
    turn.travel = travel;
    turn.lift = lift;
    if (reducedMotion.matches) return;
    const geometry = foldGeometry(box.width, box.height, anchor, {
      x: anchor.x - direction * Math.max(0.5, travel),
      y: anchor.y + lift,
    });
    front.style.clipPath = polygon(geometry.front);
    shadow.style.clipPath = polygon(geometry.revealed);
    reverse.style.clipPath = polygon(geometry.reverse);
    stage.style.setProperty("--fold-angle", geometry.gradientAngle + "deg");
    stage.style.setProperty("--fold-line", "calc(50% + " + geometry.gradientOffset + "px)");
  }

  function settle(advance) {
    cancelAnimationFrame(frame);
    pendingMotion = null;
    const { page, box, travel, lift } = turn;
    if (reducedMotion.matches) {
      clear();
      if (advance) commit(page);
      return;
    }
    const target = advance ? box.width * 2 + 4 : 0;
    const duration = advance ? Math.max(170, 420 - (travel / box.width) * 205) : 200;
    const started = performance.now();

    function animate(now) {
      const time = Math.min(1, (now - started) / duration);
      const ease = 1 - (1 - time) ** 3;
      paint(travel + (target - travel) * ease, lift * (1 - ease));
      if (time < 1) {
        frame = requestAnimationFrame(animate);
      } else {
        clear();
        if (advance) commit(page);
      }
    }

    frame = requestAnimationFrame(animate);
  }

  function shift(direction) {
    if (turn) return;
    const box = stage.getBoundingClientRect();
    if (!begin(direction, box, box.height)) return;
    paint(1, -1);
    settle(true);
  }

  function onDown(event) {
    if (turn || !event.isPrimary || event.button !== 0) return;
    const box = stage.getBoundingClientRect();
    pointer = {
      id: event.pointerId, box, x: event.clientX, y: event.clientY,
      downAt: performance.now(), direction: 0,
    };
  }

  function onMove(event) {
    if (pointer?.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    const { box } = pointer;
    if (!pointer.direction) {
      if (Math.abs(dx) < 9 || Math.abs(dx) < Math.abs(dy) * 0.85) return;
      const direction = dx < 0 ? 1 : -1;
      const y = pointer.y - box.top;
      const edgeY = y < box.height * 0.28 ? 0 : y > box.height * 0.72 ? box.height : y;
      if (!begin(direction, box, edgeY)) {
        pointer = null;
        return;
      }
      pointer.direction = direction;
      stage.setPointerCapture(event.pointerId);
    }

    const travel = Math.max(1, Math.min(box.width * 2, -dx * pointer.direction));
    const lift = Math.max(-travel * 1.4, Math.min(travel * 1.4, dy));
    pendingMotion = { travel, lift };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (turn && pendingMotion) paint(pendingMotion.travel, pendingMotion.lift);
    });
  }

  function onUp(event, cancelled) {
    if (pointer?.id !== event.pointerId) return;
    const gesture = pointer;
    pointer = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!gesture.direction) return;
    const travelled = (gesture.x - event.clientX) * gesture.direction;
    const quickSwipe = travelled >= 32 && performance.now() - gesture.downAt < 240;
    const advance = !cancelled && (travelled > gesture.box.width * 0.23 || quickSwipe);
    if (pendingMotion) paint(pendingMotion.travel, pendingMotion.lift);
    settle(advance);
  }

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", (event) => onUp(event, false));
  stage.addEventListener("pointercancel", (event) => onUp(event, true));

  return { shift, clear };
}
