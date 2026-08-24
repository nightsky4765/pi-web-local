const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function initEffects() {
  if (reduceMotion.matches) return;

  let frame = 0;
  document.addEventListener("pointermove", (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--pointer-x", `${event.clientX}px`);
      document.documentElement.style.setProperty("--pointer-y", `${event.clientY}px`);
      frame = 0;
    });
  }, { passive: true });

  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement("i");
    ripple.className = "ripple";
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    button.append(ripple);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
  });

  document.addEventListener("pointermove", (event) => {
    const card = event.target.closest(".suggestions button");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    card.style.setProperty("--tilt-x", `${(-y * 2.4).toFixed(2)}deg`);
    card.style.setProperty("--tilt-y", `${(x * 3.2).toFixed(2)}deg`);
  }, { passive: true });

  document.addEventListener("pointerout", (event) => {
    const card = event.target.closest(".suggestions button");
    if (!card || card.contains(event.relatedTarget)) return;
    card.style.removeProperty("--tilt-x");
    card.style.removeProperty("--tilt-y");
  });
}
