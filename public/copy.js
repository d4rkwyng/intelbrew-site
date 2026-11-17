// Copy buttons: copy the text of the element named by data-copy.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    button.textContent = "Copied";
  } catch {
    // Clipboard unavailable (old browser, insecure context): select the text instead.
    const range = document.createRange();
    range.selectNodeContents(source);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    button.textContent = "Selected";
  }
  setTimeout(() => { button.textContent = label; }, 1600);
});
