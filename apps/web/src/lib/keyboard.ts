/** True when a global keyboard shortcut should leave an active text control alone. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]');
}
