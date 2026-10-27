export interface SectionTab {
  id: string;
  label: string;
  panel: HTMLElement;
}

/** Switch mounted panels without losing drafts, filters, or per-panel scroll position. */
export function mountSectionTabs(root: HTMLElement, sections: SectionTab[]) {
  root.setAttribute("role", "tablist");
  root.setAttribute("aria-label", "Tray Platform sections");
  const scrollPositions = new Map<string, number>();
  const badges: HTMLElement[] = [];
  let active: SectionTab | undefined;
  const buttons = sections.map(section => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `tab-${section.id}`;
    const label = document.createElement("span"); label.dataset.tabLabel = ""; label.textContent = section.label;
    const badge = document.createElement("span"); badge.dataset.tabBadge = ""; badge.hidden = true; badge.setAttribute("aria-hidden", "true");
    badges.push(badge); button.append(label, badge);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", section.id);
    section.panel.id = section.id;
    section.panel.setAttribute("role", "tabpanel");
    section.panel.setAttribute("aria-labelledby", button.id);
    section.panel.tabIndex = 0;
    root.appendChild(button);
    return button;
  });

  function select(id: string, focus = false) {
    const next = sections.find(section => section.id === id);
    if (!next) return;
    const changed = active !== next;
    const restoreFocus = focus || Boolean(changed && active?.panel.contains(document.activeElement));
    if (changed && active) scrollPositions.set(active.id, window.scrollY);
    active = next;
    sections.forEach((section, index) => {
      const selected = section === next;
      section.panel.hidden = !selected;
      buttons[index].setAttribute("aria-selected", String(selected));
      buttons[index].tabIndex = selected ? 0 : -1;
    });
    if (changed) window.scrollTo(0, scrollPositions.get(id) || 0);
    const button = buttons[sections.indexOf(next)];
    if (restoreFocus) button.focus({ preventScroll: true });
    // Reveal overflowing tabs horizontally without disturbing the panel's scroll position.
    const left = button.offsetLeft, right = left + button.offsetWidth;
    if (left < root.scrollLeft + 4) root.scrollLeft = left - 4;
    else if (right > root.scrollLeft + root.clientWidth - 4) root.scrollLeft = right - root.clientWidth + 4;
  }

  function click(event: MouseEvent) {
    const index = buttons.indexOf((event.target as HTMLElement).closest("button") as HTMLButtonElement);
    if (index >= 0) select(sections[index].id, true);
  }

  function keydown(event: KeyboardEvent) {
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % sections.length; break;
      case "ArrowLeft": next = (index + sections.length - 1) % sections.length; break;
      case "Home": next = 0; break;
      case "End": next = sections.length - 1; break;
      default: return;
    }
    event.preventDefault();
    select(sections[next].id, true);
  }

  root.addEventListener("click", click);
  root.addEventListener("keydown", keydown);
  if (sections.length) select(sections[0].id);
  return {
    select,
    setBadge(id: string, count: number, description: string) {
      const index = sections.findIndex(section => section.id === id);
      if (index < 0) return;
      const badge = badges[index];
      badge.textContent = count > 0 ? String(count) : ""; badge.hidden = count <= 0;
      badge.title = description;
      buttons[index].setAttribute("aria-label", count > 0 ? `${sections[index].label}, ${description}` : sections[index].label);
    },
    dispose() {
      root.removeEventListener("click", click);
      root.removeEventListener("keydown", keydown);
    },
  };
}
